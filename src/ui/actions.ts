import { cancelRun, rerunFailedJobs, rerunRun } from '../github/api'
import { refreshNow } from '../github/poller'
import type { RepoRef, RunWithRepo } from '../github/types'
import { actionError, cancelRequested, recentlyFinished } from '../state/store'

/**
 * The writes the reader can make: cancelling runs and re-running them. Errors
 * go to actionError, which the next poll leaves alone, and a successful write
 * asks for a poll at once so its effect shows.
 */

/** GitHub asks for about a second between writes, to stay clear of its secondary limits. */
const SPACING_MS = 1_000

export interface Target {
  repo: RepoRef
  run: RunWithRepo
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function markRequested(runId: number): void {
  const next = new Map(cancelRequested.peek())
  next.set(runId, Date.now())
  cancelRequested.value = next
}

/**
 * Cancels runs one at a time, spaced apart, marking each so its row says the
 * cancel was asked for instead of offering the button again before GitHub
 * catches up. Returns how many went through.
 */
export async function cancelRuns(
  targets: readonly Target[],
  options: { spacingMs?: number; onProgress?: (done: number) => void } = {},
): Promise<number> {
  const spacing = options.spacingMs ?? SPACING_MS
  const failures: string[] = []
  for (const [i, { repo, run }] of targets.entries()) {
    if (i > 0 && spacing > 0) await sleep(spacing)
    try {
      await cancelRun(repo, run.id)
      markRequested(run.id)
    } catch (err) {
      failures.push(`${repo.name} #${run.run_number} (${(err as Error).message})`)
    }
    options.onProgress?.(i + 1)
  }
  if (failures.length > 0) {
    actionError.value =
      targets.length === 1
        ? `Could not cancel ${failures[0]}.`
        : `${failures.length} of ${targets.length} cancels failed: ${failures.join(', ')}.`
  }
  refreshNow({ force: true })
  return targets.length - failures.length
}

/**
 * Re-runs a finished run: only its failed jobs, or all of it, which undoes a
 * cancel made by mistake. GitHub refuses either while the run is still active.
 */
export async function rerun(repo: RepoRef, run: RunWithRepo, mode: 'failed' | 'all'): Promise<boolean> {
  try {
    if (mode === 'failed') await rerunFailedJobs(repo, run.id)
    else await rerunRun(repo, run.id)
  } catch (err) {
    actionError.value = `Could not re-run ${repo.name} #${run.run_number}: ${(err as Error).message}`
    return false
  }
  recentlyFinished.value = recentlyFinished
    .peek()
    .map((f) => (f.run.id === run.id ? { ...f, rerunAsked: true } : f))
  refreshNow({ force: true })
  return true
}
