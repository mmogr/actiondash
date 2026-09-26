import type { RunWithRepo, WorkflowJob } from '../github/types'
import { isFailedJob } from './queue'

/**
 * Runs the dashboard saw finish, and how. Built from job listings the poller
 * already holds or already fetches to learn durations, so knowing costs no
 * request of its own. Kept for the session only.
 */

export type Outcome =
  /** At least one job failed or timed out. */
  | 'failed'
  /** Stopped by a cancel. */
  | 'cancelled'
  /** Every job finished without failing. */
  | 'succeeded'
  /** Left the active listings with jobs unfinished: waiting on an approval or a concurrency group. */
  | 'left'
  /** Not checked, because the hourly allowance was low. */
  | 'unknown'

export interface FinishedRun {
  run: RunWithRepo
  outcome: Outcome
  failedJobs: { id: number; name: string; url: string }[]
  /** When the dashboard saw it leave. */
  at: number
  /** Cancelled from this page, so a re-run is offered as the way back. */
  cancelledHere: boolean
  /** A re-run was asked for from this page. */
  rerunAsked: boolean
}

export const KEEP_FINISHED = 20
export const FINISHED_MAX_AGE_MS = 60 * 60_000
/** How long a cancel stands as "requested" before the row may show its button again. */
export const CANCEL_REQUEST_TTL_MS = 2 * 60_000

export function classifyFinished(jobs: readonly WorkflowJob[] | null): {
  outcome: Outcome
  failed: WorkflowJob[]
} {
  if (!jobs || jobs.length === 0) return { outcome: 'unknown', failed: [] }
  const failed = jobs.filter(isFailedJob)
  if (failed.length > 0) return { outcome: 'failed', failed }
  if (jobs.some((j) => j.status !== 'completed')) return { outcome: 'left', failed: [] }
  if (jobs.some((j) => j.conclusion === 'cancelled')) return { outcome: 'cancelled', failed: [] }
  return { outcome: 'succeeded', failed: [] }
}

/**
 * Newest first, one entry per run. A run that is active again, because it was
 * re-run, leaves the list, and so does anything past the age limit.
 */
export function addFinished(
  list: readonly FinishedRun[],
  added: readonly FinishedRun[],
  activeIds: ReadonlySet<number>,
  nowMs: number,
): FinishedRun[] {
  const replaced = new Set(added.map((f) => f.run.id))
  return [...added, ...list.filter((f) => !replaced.has(f.run.id))]
    .filter((f) => !activeIds.has(f.run.id) && nowMs - f.at <= FINISHED_MAX_AGE_MS)
    .slice(0, KEEP_FINISHED)
}

export function isCancelRequested(
  requested: ReadonlyMap<number, number>,
  runId: number,
  nowMs: number,
): boolean {
  const at = requested.get(runId)
  return at !== undefined && nowMs - at < CANCEL_REQUEST_TTL_MS
}
