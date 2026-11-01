import type { RunnerClass, RunWithRepo, WorkflowJob } from '../github/types'
import { durationKey, fallbackSeconds, typicalSeconds, type DurationMap } from './durations'
import { worstBasis, type Basis, type BucketForecast } from './forecast'
import { capFor, type Plan } from './plans'
import { jobState, type GraphNode, type RunGraph } from './workflow'

/**
 * When the jobs that do not exist yet should run, and so when a whole run
 * should be done.
 *
 * GitHub creates a job only once everything it needs has finished, so the
 * pool forecasts know nothing of a run's later stages. A run with a graph
 * knows them: each is created when its needs are expected to end, then waits
 * its turn in its pool like any other job.
 *
 * Every such job is created after now, and the pools are first come first
 * served, so each one lands behind every job already waiting. That is why
 * this can run after the pool forecasts and leave them untouched: it takes
 * each pool's slots as the forecast leaves them and carries on from there.
 * It still has to work across pools in time order, because a macOS job can be
 * waiting on Linux jobs, and on other jobs that do not exist yet either.
 *
 * The cancel-first insight (insightFor) does not see these jobs. It compares
 * the queue with and without a stale run, and jobs that are not there yet
 * make no difference to who is ahead of whom now.
 */

export interface FutureNode {
  node: GraphNode
  /** Expected creation, start and end, epoch ms; null where something before it is unknown. */
  created: number | null
  start: number | null
  end: number | null
  basis: Basis
  /** The pool it will use, when the file says. */
  cls: RunnerClass | null
  /** Jobs expected; at least one when the run decides. */
  count: number
  /** It will probably be skipped, because something it needs failed. */
  likelySkipped: boolean
}

export interface GraphOutlook {
  /** When the whole run should be done, including jobs not created yet. Null when anything is unknown. */
  allDone: number | null
  basis: Basis
  /** Nodes without jobs yet, by node id. */
  future: Map<string, FutureNode>
}

interface Lane {
  freeAt: number | null
  basis: Basis
}

export interface GraphForecastInput {
  graphs: ReadonlyMap<number, RunGraph>
  runs: ReadonlyMap<number, RunWithRepo>
  forecasts: ReadonlyMap<string, { forecast: BucketForecast }>
  durations: DurationMap
  plan: Plan
  nowMs: number
}

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN)

/** The usual length of one expected job, from its exact name when the file gives one. */
function usualFor(
  node: GraphNode,
  index: number,
  run: RunWithRepo,
  cls: RunnerClass | null,
  durations: DurationMap,
): { seconds: number | null; guessed: boolean } {
  const name = node.exactNames?.[index] ?? node.exactNames?.[0]
  if (name) {
    const own = typicalSeconds(durations, durationKey({ owner: run.repoOwner, name: run.repoName }, name))
    if (own !== undefined) return { seconds: own, guessed: false }
  }
  const fallback = cls ? fallbackSeconds(durations, cls) : undefined
  return { seconds: fallback ?? null, guessed: true }
}

/** Each pool's slots after the jobs already running and waiting, by when each frees. */
function lanesAfterQueue(input: GraphForecastInput): Map<RunnerClass, Lane[]> {
  const lanes = new Map<RunnerClass, Lane[]>()
  for (const [cls, { forecast }] of input.forecasts) {
    const list: Lane[] = Array.from({ length: forecast.lanes }, () => ({ freeAt: input.nowMs, basis: 'learned' as Basis }))
    for (const f of forecast.jobs.values()) {
      const lane = list[f.lane]
      if (!lane) continue
      const own: Basis = f.guessed ? 'guessed' : 'learned'
      if (f.end === null || lane.freeAt === null) lane.freeAt = null
      else lane.freeAt = Math.max(lane.freeAt, f.end)
      lane.basis = worstBasis(lane.basis, worstBasis(f.basis, own))
    }
    lanes.set(cls as RunnerClass, list)
  }
  return lanes
}

/** When a job that exists should end: its real end, or the pool forecast's. */
function existingEnd(job: WorkflowJob, input: GraphForecastInput): { end: number | null; basis: Basis } {
  if (job.status === 'completed') {
    const t = time(job.completed_at)
    return { end: Number.isNaN(t) ? input.nowMs : t, basis: 'learned' }
  }
  for (const { forecast } of input.forecasts.values()) {
    const f = forecast.jobs.get(job.id)
    if (f) return { end: f.end, basis: worstBasis(f.basis, f.guessed ? 'guessed' : 'learned') }
  }
  return { end: null, basis: 'learned' }
}

export function forecastGraphs(input: GraphForecastInput): Map<number, GraphOutlook> {
  const lanes = lanesAfterQueue(input)
  const laneFor = (cls: RunnerClass): Lane[] | null => {
    if (capFor(input.plan, cls) === null) return null
    let list = lanes.get(cls)
    if (!list) {
      list = Array.from({ length: capFor(input.plan, cls)! }, () => ({ freeAt: input.nowMs, basis: 'learned' as Basis }))
      lanes.set(cls, list)
    }
    return list
  }

  // Ends known so far, by run and node: real or forecast for nodes with jobs,
  // filled in for future nodes as they are placed.
  type End = { end: number | null; basis: Basis; failed: boolean }
  const ends = new Map<number, Map<string, End>>()
  const pending: { runId: number; run: RunWithRepo; node: GraphNode }[] = []
  const outlooks = new Map<number, GraphOutlook>()

  for (const [runId, g] of input.graphs) {
    const run = input.runs.get(runId)
    if (!run) continue
    const known = new Map<string, End>()
    ends.set(runId, known)
    outlooks.set(runId, { allDone: null, basis: 'learned', future: new Map() })
    for (const node of g.graph.nodes) {
      if (g.neverRuns.has(node.id)) continue
      const jobs = g.instances.get(node.id) ?? []
      if (jobs.length === 0) {
        pending.push({ runId, run, node })
        continue
      }
      let end: number | null = -Infinity
      let basis: Basis = 'learned'
      for (const job of jobs) {
        const e = existingEnd(job, input)
        end = end === null || e.end === null ? null : Math.max(end, e.end)
        basis = worstBasis(basis, e.basis)
      }
      const failed = jobs.some((j) => ['failed', 'cancelled'].includes(jobState(j)))
      known.set(node.id, { end, basis, failed })
    }
  }

  // Place future nodes in the order they will be created, across every run
  // and pool, since they compete for the same slots.
  while (pending.length > 0) {
    let pick = -1
    let pickCreated = Infinity
    let pickBasis: Basis = 'learned'
    let pickUnknown = false
    let pickSkip = false
    for (let i = 0; i < pending.length; i++) {
      const { runId, node } = pending[i]!
      const known = ends.get(runId)!
      let created = input.nowMs
      let basis: Basis = 'learned'
      let ready = true
      let unknown = false
      let skip = false
      for (const dep of node.needs) {
        const e = known.get(dep)
        if (e === undefined) {
          // A need that is itself still to be placed; or one under a skipped
          // call, which never ends because it never runs.
          if (pending.some((p) => p.runId === runId && p.node.id === dep)) ready = false
          continue
        }
        if (e.end === null) unknown = true
        else created = Math.max(created, e.end)
        basis = worstBasis(basis, e.basis)
        if (e.failed) skip = true
      }
      if (!ready) continue
      if (unknown || created < pickCreated) {
        pick = i
        pickCreated = unknown ? Infinity : created
        pickBasis = basis
        pickUnknown = unknown
        pickSkip = skip
        if (unknown) break
      }
    }
    if (pick === -1) break // a cycle in a broken file; leave the rest unknown
    const { runId, run, node } = pending.splice(pick, 1)[0]!
    const outlook = outlooks.get(runId)!
    const count = node.count ?? 1
    // A job that may be skipped, or whose count the run decides, rests on a guess.
    let basis = worstBasis(pickBasis, node.conditional || node.count === null ? 'guessed' : 'learned')
    let start: number | null = null
    let end: number | null = pickUnknown ? null : -Infinity
    const cls = node.classes?.[0] ?? null
    if (!pickUnknown && !pickSkip) {
      for (let k = 0; k < count; k++) {
        const jobCls = node.classes?.[k] ?? cls
        const usual = usualFor(node, k, run, jobCls, input.durations)
        if (usual.guessed) basis = worstBasis(basis, 'guessed')
        const pool = jobCls ? laneFor(jobCls) : null
        let jobStart = pickCreated
        if (pool) {
          let best: Lane | null = null
          for (const lane of pool) if (lane.freeAt !== null && (best === null || lane.freeAt < best.freeAt!)) best = lane
          if (best === null) {
            end = null
            start = null
            break
          }
          jobStart = Math.max(pickCreated, best.freeAt!)
          basis = worstBasis(basis, best.basis)
          best.freeAt = usual.seconds === null ? null : jobStart + usual.seconds * 1000
          best.basis = worstBasis(best.basis, basis)
        }
        start = start === null ? jobStart : Math.min(start, jobStart)
        if (usual.seconds === null || end === null) end = null
        else end = Math.max(end, jobStart + usual.seconds * 1000)
      }
    }
    if (pickSkip) {
      // What it needs failed, so GitHub will skip it the moment it would be
      // created, unless its `if:` says always. It takes no slot either way.
      start = pickUnknown ? null : pickCreated
      end = start
    }
    outlook.future.set(node.id, {
      node,
      created: pickUnknown ? null : pickCreated,
      start,
      end,
      basis,
      cls,
      count,
      likelySkipped: pickSkip,
    })
    ends.get(runId)!.set(node.id, { end, basis, failed: pickSkip })
  }

  // A future node left over waits on something that never resolves.
  for (const { runId, node } of pending) {
    outlooks.get(runId)!.future.set(node.id, {
      node,
      created: null,
      start: null,
      end: null,
      basis: 'guessed',
      cls: node.classes?.[0] ?? null,
      count: node.count ?? 1,
      likelySkipped: false,
    })
    ends.get(runId)!.set(node.id, { end: null, basis: 'guessed', failed: false })
  }

  for (const [runId, outlook] of outlooks) {
    let allDone: number | null = -Infinity
    let basis: Basis = 'learned'
    for (const e of ends.get(runId)!.values()) {
      allDone = allDone === null || e.end === null ? null : Math.max(allDone, e.end)
      basis = worstBasis(basis, e.basis)
    }
    outlook.allDone = allDone === -Infinity ? null : allDone
    outlook.basis = basis
  }
  return outlooks
}
