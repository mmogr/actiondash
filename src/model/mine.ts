import type { RunnerClass, RunWithRepo, WorkflowJob } from '../github/types'
import { runOutlook, type BucketForecast } from './forecast'
import { runProgress, type ClassBucket, type DashJob } from './queue'

/**
 * The reader's own runs, picked out of everyone's. A run is theirs when they
 * pushed it or set it going. Pure; the store holds the login.
 */

export function isMine(run: RunWithRepo, login: string | null): boolean {
  if (!login) return false
  const me = login.toLowerCase()
  return run.actor?.login.toLowerCase() === me || run.triggering_actor?.login.toLowerCase() === me
}

export interface MyRun {
  run: RunWithRepo
  /** Running once any of its jobs holds a slot. */
  state: 'running' | 'queued'
  stale: boolean
  /** When its first job should start, for a run with nothing running yet. */
  startsAt: number | null
  /** When the jobs it has now should be done. */
  doneAt: number | null
  /** How long it has been waiting, or running. */
  since: number
  /** For a run still waiting: its place in the pool it waits for. */
  position: {
    at: number
    of: number
    cls: RunnerClass
    /** The nearest other run ahead of it, or null when it is next in line. */
    behind: RunWithRepo | null
  } | null
  failed: WorkflowJob[]
}

function earliest(jobs: readonly DashJob[]): number {
  let first = 0
  for (const j of jobs) if (j.since > 0 && (first === 0 || j.since < first)) first = j.since
  return first
}

/**
 * The reader's active runs, running ones first, then waiting ones in the order
 * they will start.
 */
export function myRuns(
  buckets: readonly ClassBucket[],
  forecasts: ReadonlyMap<string, { forecast: BucketForecast }>,
  jobsByRun: ReadonlyMap<number, readonly WorkflowJob[]>,
  login: string | null,
): MyRun[] {
  if (!login) return []
  const running = new Map<number, DashJob[]>()
  const queued = new Map<number, DashJob[]>()
  const runsById = new Map<number, RunWithRepo>()
  const stale = new Set<number>()
  for (const bucket of buckets) {
    for (const [list, into] of [
      [bucket.running, running],
      [bucket.queued, queued],
    ] as const) {
      for (const j of list) {
        if (!isMine(j.run, login)) continue
        runsById.set(j.run.id, j.run)
        if (j.supersededBy) stale.add(j.run.id)
        const jobs = into.get(j.run.id)
        if (jobs) jobs.push(j)
        else into.set(j.run.id, [j])
      }
    }
  }

  const outlooks = [...forecasts.values()].map((v) => v.forecast)
  const out: MyRun[] = []
  for (const [id, run] of runsById) {
    const isRunning = running.has(id)
    const outlook = runOutlook(id, outlooks)
    out.push({
      run,
      state: isRunning ? 'running' : 'queued',
      stale: stale.has(id),
      startsAt: isRunning ? null : (outlook?.firstStart ?? null),
      doneAt: outlook?.allDone ?? null,
      since: earliest((isRunning ? running.get(id) : queued.get(id)) ?? []),
      position: isRunning ? null : positionOf(id, buckets),
      failed: runProgress(jobsByRun.get(id)).failed,
    })
  }

  return out.sort((a, b) => {
    if (a.state !== b.state) return a.state === 'running' ? -1 : 1
    if (a.position && b.position) return a.position.at - b.position.at
    return a.since - b.since
  })
}

/** Where a waiting run's first job stands in the pool it waits for. */
function positionOf(runId: number, buckets: readonly ClassBucket[]): MyRun['position'] {
  let best: MyRun['position'] = null
  for (const bucket of buckets) {
    const index = bucket.queued.findIndex((j) => j.run.id === runId)
    if (index === -1 || (best && index + 1 >= best.at)) continue
    let behind: RunWithRepo | null = null
    for (let i = index - 1; i >= 0; i--) {
      const ahead = bucket.queued[i]!.run
      if (ahead.id !== runId) {
        behind = ahead
        break
      }
    }
    best = { at: index + 1, of: bucket.queued.length, cls: bucket.cls, behind }
  }
  return best
}
