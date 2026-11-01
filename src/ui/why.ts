import type { RunnerClass, RunWithRepo, WorkflowJob } from '../github/types'
import { worstBasis, type Basis, type BucketForecast } from '../model/forecast'
import type { GraphOutlook } from '../model/graphForecast'
import type { ClassBucket, DashJob } from '../model/queue'
import { jobRunnerClass } from '../model/runnerClass'
import { jobState, type RunGraph } from '../model/workflow'

/**
 * What the sheet says about one node of a run's graph: why it is waiting, when
 * it should start, and who is ahead of it. Pure; the sheet only draws it.
 */

export interface AheadGroup {
  run: RunWithRepo
  names: string[]
  count: number
}

export interface StripBar {
  lane: number
  start: number
  end: number
  run: RunWithRepo
  name: string
  running: boolean
  /** The job the sheet is about. */
  mine: boolean
}

export type Why =
  | {
      kind: 'waiting'
      cls: RunnerClass
      /** One-based place in line of the node's first waiting job. */
      position: number
      of: number
      startsAt: number | null
      basis: Basis
      since: number
      ahead: AheadGroup[]
      /** Job ids ahead in line, to mark where they are drawn. */
      aheadIds: Set<number>
      /** The running job expected to free a slot first, and when. */
      next: { entry: DashJob; at: number | null; basis: Basis } | null
      lanes: number
      bars: StripBar[]
    }
  | {
      kind: 'future'
      needs: string[]
      created: number | null
      startsAt: number | null
      basis: Basis
      cls: RunnerClass | null
      /** Jobs waiting in its pool now, which it will be behind. */
      waitingNow: number
      likelySkipped: boolean
      count: number
      exact: boolean
    }
  | { kind: 'running'; jobs: { job: WorkflowJob; cls: RunnerClass; end: number | null; typical: number | null; basis: Basis }[] }
  | { kind: 'done'; jobs: WorkflowJob[] }

export interface WhyInput {
  run: RunWithRepo
  graph: RunGraph
  nodeId: string
  buckets: readonly ClassBucket[]
  forecasts: ReadonlyMap<string, { forecast: BucketForecast }>
  outlook: GraphOutlook | undefined
  /** Label of each node, for naming what a future job waits for. */
  labels: ReadonlyMap<string, string>
}

export function whyFor(input: WhyInput): Why | null {
  const node = input.graph.graph.nodes.find((n) => n.id === input.nodeId)
  if (!node) return null
  const jobs = input.graph.instances.get(node.id) ?? []

  if (jobs.length === 0) {
    const f = input.outlook?.future.get(node.id)
    const cls = f?.cls ?? node.classes?.[0] ?? null
    const bucket = cls ? input.buckets.find((b) => b.cls === cls) : undefined
    return {
      kind: 'future',
      needs: node.needs.map((d) => input.labels.get(d) ?? d),
      created: f?.created ?? null,
      startsAt: f?.start ?? null,
      basis: f?.basis ?? 'guessed',
      cls,
      waitingNow: bucket?.queued.length ?? 0,
      likelySkipped: f?.likelySkipped ?? false,
      count: f?.count ?? node.count ?? 1,
      exact: node.count !== null,
    }
  }

  const waiting = jobs.filter((j) => jobState(j) === 'waiting')
  for (const bucket of input.buckets) {
    const index = bucket.queued.findIndex((e) => waiting.some((j) => j.id === e.job.id))
    if (index === -1) continue
    const forecast = input.forecasts.get(bucket.cls)?.forecast
    const first = bucket.queued[index]!
    const f = forecast?.jobs.get(first.job.id)
    const ahead = bucket.queued.slice(0, index)
    const groups = new Map<number, AheadGroup>()
    for (const e of ahead) {
      const g = groups.get(e.run.id) ?? { run: e.run, names: [], count: 0 }
      g.count++
      const base = e.job.name.replace(/ \(.*\)$/, '')
      if (!g.names.includes(base)) g.names.push(base)
      groups.set(e.run.id, g)
    }
    const next = forecast?.nextToFinish ?? null
    const bars: StripBar[] = []
    if (forecast) {
      const mineIds = new Set(waiting.map((j) => j.id))
      const keep = new Set([...bucket.running.map((e) => e.job.id), ...ahead.map((e) => e.job.id), ...mineIds])
      for (const jf of forecast.jobs.values()) {
        if (!keep.has(jf.entry.job.id) || jf.end === null) continue
        const start = jf.start > 0 ? jf.start : null
        if (start === null) continue
        bars.push({
          lane: jf.lane,
          start,
          end: jf.end,
          run: jf.entry.run,
          name: jf.entry.job.name,
          running: bucket.running.includes(jf.entry),
          mine: mineIds.has(jf.entry.job.id),
        })
      }
    }
    return {
      kind: 'waiting',
      cls: bucket.cls,
      position: index + 1,
      of: bucket.queued.length,
      startsAt: f && f.start > 0 ? f.start : null,
      basis: f?.basis ?? 'learned',
      since: first.since,
      ahead: [...groups.values()],
      aheadIds: new Set(ahead.map((e) => e.job.id)),
      next: next ? { entry: next, at: forecast?.nextSlotAt ?? null, basis: forecast?.nextSlotBasis ?? 'learned' } : null,
      lanes: forecast?.lanes ?? 0,
      bars,
    }
  }

  const running = jobs.filter((j) => jobState(j) === 'running')
  if (running.length > 0) {
    return {
      kind: 'running',
      jobs: running.map((job) => {
        for (const { forecast } of input.forecasts.values()) {
          const f = forecast.jobs.get(job.id)
          if (f) return { job, cls: jobRunnerClass(job), end: f.end, typical: f.typical, basis: worstBasis(f.basis, f.guessed ? 'guessed' : 'learned') }
        }
        return { job, cls: jobRunnerClass(job), end: null, typical: null, basis: 'learned' as Basis }
      }),
    }
  }
  return { kind: 'done', jobs }
}
