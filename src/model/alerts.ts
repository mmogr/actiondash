import type { RepoRef, RunWithRepo } from '../github/types'
import type { FinishedRun } from './finished'
import { isMine } from './mine'
import { RUNNER_CLASS_LABEL } from './runnerClass'
import type { ClassBucket, DashJob } from './queue'

/**
 * What changed between two polls that a reader waiting on the pool would want
 * to hear about. Pure: it compares two pictures and names the differences.
 * Showing them is notify.ts's job.
 */

export interface AlertPrefs {
  /** One of the reader's own runs took its first slot. */
  myStarted: boolean
  /** One of the reader's own runs left the queue, however it ended. */
  myFinished: boolean
  /** A slot in a capped pool freed while something was waiting for it. */
  slotFreed: boolean
  /** A job that was queued is now running. */
  jobStarted: boolean
  /** A run has been made pointless by a newer one. */
  superseded: boolean
}

export const NO_ALERTS: AlertPrefs = {
  myStarted: false,
  myFinished: false,
  slotFreed: false,
  jobStarted: false,
  superseded: false,
}

export interface Alert {
  /** Stable per event, so the same news is never shown twice. */
  tag: string
  title: string
  body: string
  /** The run the news is about, so tapping it can open that run. */
  runId?: number
}

/** What a finished run's alert says. Facts only: a failed job can still leave its run passing. */
function finishedBody(f: FinishedRun): string {
  switch (f.outcome) {
    case 'failed': {
      const names = f.failedJobs.map((j) => j.name)
      return names.length === 1
        ? `Job ${names[0]} failed.`
        : `Jobs ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} failed.`
    }
    case 'succeeded':
      return 'It passed.'
    case 'cancelled':
      return 'It was cancelled.'
    case 'left':
      return 'It left the queue unfinished; it may be waiting for an approval.'
    case 'unknown':
      return 'It finished; its result was not checked.'
  }
}

function runName(repo: RepoRef, run: RunWithRepo): string {
  return `${repo.name} #${run.run_number}`
}

export function alertsFor(
  previous: readonly ClassBucket[],
  next: readonly ClassBucket[],
  prefs: AlertPrefs,
  extra: { login?: string | null; finished?: readonly FinishedRun[] } = {},
): Alert[] {
  const out: Alert[] = []
  const before = new Map(previous.map((b) => [b.cls, b]))
  const login = extra.login ?? null

  // The reader's own runs that hold a slot now and held none before. Checked
  // across every pool, since a run can start in one and wait in another.
  const startedMine = new Set<number>()
  if (prefs.myStarted && login) {
    const wasRunning = new Set(previous.flatMap((b) => b.running.map((j) => j.run.id)))
    const firstRunning = new Map<number, { job: DashJob; pool: string }>()
    for (const bucket of next) {
      for (const j of bucket.running) {
        if (wasRunning.has(j.run.id) || firstRunning.has(j.run.id) || !isMine(j.run, login)) continue
        firstRunning.set(j.run.id, { job: j, pool: RUNNER_CLASS_LABEL[bucket.cls] })
      }
    }
    for (const [runId, { job, pool }] of firstRunning) {
      startedMine.add(runId)
      out.push({
        tag: `mine-started:${runId}:${job.run.run_attempt ?? 1}`,
        title: `${runName(job.repo, job.run)} started`,
        body: `${job.job.name} took a ${pool} slot.`,
        runId,
      })
    }
  }

  if (prefs.myFinished && login) {
    for (const f of extra.finished ?? []) {
      if (!isMine(f.run, login)) continue
      out.push({
        tag: `finished:${f.run.id}:${f.run.run_attempt ?? 1}`,
        title: `${f.run.repoName} #${f.run.run_number} finished`,
        body: finishedBody(f),
        runId: f.run.id,
      })
    }
  }

  for (const bucket of next) {
    const was = before.get(bucket.cls)
    if (!was) continue
    const pool = RUNNER_CLASS_LABEL[bucket.cls]

    if (prefs.slotFreed && bucket.cap !== null) {
      const freed = was.running.length >= bucket.cap && bucket.running.length < bucket.cap
      if (freed && bucket.queued.length > 0) {
        const next = bucket.queued[0]!
        out.push({
          tag: `slot:${bucket.cls}:${bucket.running.length}:${next.job.id}`,
          title: `A ${pool} slot freed`,
          body: `${bucket.queued.length} waiting. Next up: ${runName(next.repo, next.run)} ${next.job.name}.`,
        })
      }
    }

    if (prefs.jobStarted) {
      const wasQueued = new Set(was.queued.map((j) => j.job.id))
      for (const j of bucket.running) {
        // Already said, as one of the reader's own runs starting.
        if (!wasQueued.has(j.job.id) || startedMine.has(j.run.id)) continue
        out.push({
          tag: `started:${j.job.id}`,
          title: `${runName(j.repo, j.run)} started`,
          body: `${j.job.name} took a ${pool} slot.`,
          runId: j.run.id,
        })
      }
    }

    if (prefs.superseded) {
      const wasStale = new Set(
        [...was.running, ...was.queued].filter((j) => j.supersededBy).map((j) => j.run.id),
      )
      const seen = new Set<number>()
      for (const j of [...bucket.running, ...bucket.queued]) {
        if (!j.supersededBy || wasStale.has(j.run.id) || seen.has(j.run.id)) continue
        seen.add(j.run.id)
        out.push({
          tag: `stale:${j.run.id}`,
          title: `${runName(j.repo, j.run)} is superseded`,
          body: `#${j.supersededBy.run_number} replaced it on ${j.run.head_branch ?? 'its branch'}. It is still ${
            bucket.running.some((r) => r.run.id === j.run.id) ? 'holding' : 'waiting for'
          } a ${pool} slot.`,
          runId: j.run.id,
        })
      }
    }
  }
  return out
}
