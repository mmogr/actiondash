import type { RepoRef, RunnerClass, RunWithRepo, WorkflowJob } from '../github/types'
import { jobRunnerClass, RUNNER_CLASS_ORDER } from './runnerClass'
import { capFor, type Plan } from './plans'
import { findSupersededRuns } from './stale'

/** Job statuses that mean the job is occupying a concurrency slot right now. */
const RUNNING_STATUSES = new Set(['in_progress'])
/** Job statuses that mean the job is waiting for a slot. */
const QUEUED_STATUSES = new Set(['queued', 'waiting', 'pending', 'requested'])

export interface DashJob {
  job: WorkflowJob
  run: RunWithRepo
  repo: RepoRef
  cls: RunnerClass
  /** The newer run that made this one pointless, when there is one. */
  supersededBy: RunWithRepo | null
  /** Epoch ms the job entered its current state. */
  since: number
}

export interface ClassBucket {
  cls: RunnerClass
  /** Account-level concurrency ceiling, or null where none applies. */
  cap: number | null
  running: DashJob[]
  /** Oldest first. Index plus one is the estimated queue position. */
  queued: DashJob[]
}

function toTime(iso: string | null): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

/**
 * Joins runs to their jobs, classifies each job by the concurrency pool it
 * draws from, and orders the waiting jobs oldest first.
 *
 * Queue position is an estimate. GitHub does not publish a job's place in line,
 * but it dispatches a pool roughly first-in first-out, so arrival order is the
 * best available proxy.
 */
export function buildBuckets(
  runs: readonly RunWithRepo[],
  jobsByRun: ReadonlyMap<number, WorkflowJob[]>,
  plan: Plan,
): ClassBucket[] {
  const superseded = findSupersededRuns(runs)
  const byClass = new Map<RunnerClass, { running: DashJob[]; queued: DashJob[] }>()

  for (const run of runs) {
    const jobs = jobsByRun.get(run.id)
    if (!jobs) continue
    for (const job of jobs) {
      const running = RUNNING_STATUSES.has(job.status)
      const queued = QUEUED_STATUSES.has(job.status)
      if (!running && !queued) continue

      const cls = jobRunnerClass(job)
      const entry: DashJob = {
        job,
        run,
        repo: { owner: run.repoOwner, name: run.repoName },
        cls,
        supersededBy: superseded.get(run.id) ?? null,
        since: running ? toTime(job.started_at ?? job.created_at) : toTime(job.created_at),
      }

      let bucket = byClass.get(cls)
      if (!bucket) {
        bucket = { running: [], queued: [] }
        byClass.set(cls, bucket)
      }
      if (running) bucket.running.push(entry)
      else bucket.queued.push(entry)
    }
  }

  const out: ClassBucket[] = []
  for (const cls of RUNNER_CLASS_ORDER) {
    const bucket = byClass.get(cls)
    // macOS is always shown. It is the pool that runs out first, and an empty
    // one is itself worth seeing.
    if (!bucket && cls !== 'macos') continue
    const running = bucket?.running ?? []
    const queued = bucket?.queued ?? []
    running.sort((a, b) => a.since - b.since)
    queued.sort((a, b) => a.since - b.since)
    out.push({ cls, cap: capFor(plan, cls), running, queued })
  }
  return out
}

/** Every job in the view whose run has already been superseded. */
export function staleJobs(buckets: readonly ClassBucket[]): DashJob[] {
  return buckets.flatMap((b) => [...b.running, ...b.queued]).filter((j) => j.supersededBy !== null)
}

/** Distinct runs behind a set of jobs, so cancelling never repeats a run. */
export function distinctRuns(jobs: readonly DashJob[]): { repo: RepoRef; run: RunWithRepo }[] {
  const seen = new Map<number, { repo: RepoRef; run: RunWithRepo }>()
  for (const j of jobs) if (!seen.has(j.run.id)) seen.set(j.run.id, { repo: j.repo, run: j.run })
  return [...seen.values()]
}
