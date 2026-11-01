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
 * Oldest first, with ties broken by run and then by job id. Ties are common:
 * every job of a run is created in the same second. Without the tiebreak the
 * order of tied jobs would follow whichever repository answered first, and the
 * queue positions shown would shuffle from one poll to the next.
 */
function compareJobs(a: DashJob, b: DashJob): number {
  return (
    a.since - b.since ||
    a.run.created_at.localeCompare(b.run.created_at) ||
    a.run.run_number - b.run.run_number ||
    a.job.id - b.job.id
  )
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
  // A run can still reach this function twice: one repository watched under two
  // spellings produces two entries, since repoKey does not normalise case. The
  // meters are a count of jobs holding slots, so identity has to come from the
  // job rather than from its position in an array. Job ids are unique across
  // GitHub, so this can never collapse two genuinely different jobs.
  const seenJobs = new Set<number>()

  for (const run of runs) {
    const jobs = jobsByRun.get(run.id)
    if (!jobs) continue
    for (const job of jobs) {
      if (seenJobs.has(job.id)) continue
      seenJobs.add(job.id)

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
    running.sort(compareJobs)
    queued.sort(compareJobs)
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

export interface PositionedJob {
  entry: DashJob
  /** One-based place in the list the job came from: the queue position for queued jobs. */
  position: number
}

/** The jobs of one run, in the order they hold in their bucket. */
export interface RunGroup {
  repo: RepoRef
  run: RunWithRepo
  supersededBy: RunWithRepo | null
  jobs: PositionedJob[]
  /** Earliest known since across the run's jobs, for the header's age. */
  since: number
}

/**
 * Folds a bucket's jobs into one entry per run, keeping each job's position so
 * the queue numbering survives the grouping. Cancelling acts on a run, not a
 * job, so a run is the natural unit to show and to act on.
 */
export function groupByRun(jobs: readonly DashJob[]): RunGroup[] {
  const groups = new Map<number, RunGroup>()
  jobs.forEach((entry, i) => {
    let group = groups.get(entry.run.id)
    if (!group) {
      group = {
        repo: entry.repo,
        run: entry.run,
        supersededBy: entry.supersededBy,
        jobs: [],
        since: entry.since,
      }
      groups.set(entry.run.id, group)
    }
    group.jobs.push({ entry, position: i + 1 })
    if (entry.since > 0 && (group.since === 0 || entry.since < group.since)) {
      group.since = entry.since
    }
  })
  return [...groups.values()]
}

/** One run, with every active job it has in any pool. The unit of the Now screen's list. */
export interface RunEntry extends RunGroup {
  /** Running once any of its jobs holds a slot; queued while every one waits. */
  state: 'running' | 'queued'
  /** The pools its active jobs use, in display order. */
  pools: RunnerClass[]
}

/**
 * Every active run once, across every pool, running ones first. A run that
 * builds on macOS and lints on Linux is one run, and the reader cancels it
 * once; listing it under each pool would show it twice. Each job keeps its
 * place in its own pool's line, since that is where it waits.
 *
 * Within running and queued, oldest first, so a list does not reorder as
 * forecasts move.
 */
export function gatherRuns(buckets: readonly ClassBucket[]): RunEntry[] {
  const entries = new Map<number, RunEntry>()
  for (const bucket of buckets) {
    for (const [list, state] of [
      [bucket.running, 'running'],
      [bucket.queued, 'queued'],
    ] as const) {
      list.forEach((entry, i) => {
        let run = entries.get(entry.run.id)
        if (!run) {
          run = { repo: entry.repo, run: entry.run, supersededBy: entry.supersededBy, jobs: [], since: 0, state: 'queued', pools: [] }
          entries.set(entry.run.id, run)
        }
        run.jobs.push({ entry, position: i + 1 })
        if (state === 'running') run.state = 'running'
        if (!run.pools.includes(bucket.cls)) run.pools.push(bucket.cls)
      })
    }
  }
  for (const run of entries.values()) {
    // Running jobs say how long the run has held a slot; while nothing runs,
    // the wait is what counts.
    const relevant = run.jobs.filter((j) => (RUNNING_STATUSES.has(j.entry.job.status)) === (run.state === 'running'))
    run.since = relevant.reduce((first, j) => (j.entry.since > 0 && (first === 0 || j.entry.since < first) ? j.entry.since : first), 0)
    run.pools.sort((a, b) => RUNNER_CLASS_ORDER.indexOf(a) - RUNNER_CLASS_ORDER.indexOf(b))
  }
  return [...entries.values()].sort((a, b) => {
    if (a.state !== b.state) return a.state === 'running' ? -1 : 1
    return a.since - b.since || a.run.created_at.localeCompare(b.run.created_at) || a.run.id - b.run.id
  })
}

/** Conclusions that mean a job did not do its work. */
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out'])

export function isFailedJob(job: WorkflowJob): boolean {
  return job.status === 'completed' && job.conclusion !== null && FAILED_CONCLUSIONS.has(job.conclusion)
}

export interface RunProgress {
  /** Jobs that have finished, however they finished. */
  done: number
  running: number
  queued: number
  /** Finished jobs that failed or timed out, in listing order. */
  failed: WorkflowJob[]
}

/**
 * How far a whole run has got, from every job its listing reports, across
 * every pool. Jobs gated behind others with `needs:` do not exist until those
 * finish, so this describes the jobs there are, not the run's eventual size.
 */
export function runProgress(jobs: readonly WorkflowJob[] | undefined): RunProgress {
  const progress: RunProgress = { done: 0, running: 0, queued: 0, failed: [] }
  for (const job of jobs ?? []) {
    if (job.status === 'completed') {
      progress.done++
      if (isFailedJob(job)) progress.failed.push(job)
    } else if (RUNNING_STATUSES.has(job.status)) {
      progress.running++
    } else if (QUEUED_STATUSES.has(job.status)) {
      progress.queued++
    }
  }
  return progress
}

/**
 * The step worth naming: the one in progress, or for a job that failed, the
 * step it failed at. Null when the listing carries no steps.
 */
export function jobStep(job: WorkflowJob): { number: number; total: number; name: string } | null {
  const steps = job.steps
  if (!steps || steps.length === 0) return null
  const step =
    steps.find((s) => s.status === 'in_progress') ??
    steps.find((s) => s.conclusion === 'failure' || s.conclusion === 'timed_out')
  return step ? { number: step.number, total: steps.length, name: step.name } : null
}

/**
 * What cancelling a set of jobs' runs would give back: the slots they hold,
 * by pool, and how many of their jobs are waiting.
 */
export function staleImpact(jobs: readonly DashJob[]): {
  holding: Partial<Record<RunnerClass, number>>
  waiting: number
} {
  const holding: Partial<Record<RunnerClass, number>> = {}
  let waiting = 0
  for (const j of jobs) {
    if (RUNNING_STATUSES.has(j.job.status)) holding[j.cls] = (holding[j.cls] ?? 0) + 1
    else waiting++
  }
  return { holding, waiting }
}
