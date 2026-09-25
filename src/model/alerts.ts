import type { RepoRef, RunWithRepo } from '../github/types'
import { RUNNER_CLASS_LABEL } from './runnerClass'
import type { ClassBucket } from './queue'

/**
 * What changed between two polls that a reader waiting on the pool would want
 * to hear about. Pure: it compares two pictures and names the differences.
 * Showing them is notify.ts's job.
 */

export interface AlertPrefs {
  /** A slot in a capped pool freed while something was waiting for it. */
  slotFreed: boolean
  /** A job that was queued is now running. */
  jobStarted: boolean
  /** A run has been made pointless by a newer one. */
  superseded: boolean
}

export const NO_ALERTS: AlertPrefs = { slotFreed: false, jobStarted: false, superseded: false }

export interface Alert {
  /** Stable per event, so the same news is never shown twice. */
  tag: string
  title: string
  body: string
}

function runName(repo: RepoRef, run: RunWithRepo): string {
  return `${repo.name} #${run.run_number}`
}

export function alertsFor(
  previous: readonly ClassBucket[],
  next: readonly ClassBucket[],
  prefs: AlertPrefs,
): Alert[] {
  const out: Alert[] = []
  const before = new Map(previous.map((b) => [b.cls, b]))

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
        if (!wasQueued.has(j.job.id)) continue
        out.push({
          tag: `started:${j.job.id}`,
          title: `${runName(j.repo, j.run)} started`,
          body: `${j.job.name} took a ${pool} slot.`,
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
        })
      }
    }
  }
  return out
}
