import type { RunWithRepo } from '../github/types'

/**
 * Detects runs that a later commit has already superseded.
 *
 * Two runs are comparable when they belong to the same repository, the same
 * workflow and the same branch. Within such a group the newest run wins, and
 * every older run on a different commit is stale: its result can no longer
 * matter, yet it is still holding or waiting for a concurrency slot.
 *
 * This uses only data already fetched for the queue view, so the token needs no
 * Contents permission. The trade-off is that a branch whose newest commit did
 * not trigger this particular workflow will not be detected, which is the
 * conservative direction to be wrong in: a run is never wrongly marked stale.
 */

function groupKey(run: RunWithRepo): string | null {
  if (!run.head_branch) return null
  return `${run.repoOwner} ${run.repoName} ${run.workflow_id} ${run.head_branch}`
}

/** True when candidate is later than reference, using run_number to break ties. */
function isNewer(candidate: RunWithRepo, reference: RunWithRepo): boolean {
  if (candidate.created_at !== reference.created_at) {
    return candidate.created_at > reference.created_at
  }
  return candidate.run_number > reference.run_number
}

/**
 * Maps run id to the newer run that superseded it. Runs absent from the map are
 * current.
 */
export function findSupersededRuns(runs: readonly RunWithRepo[]): Map<number, RunWithRepo> {
  const groups = new Map<string, RunWithRepo[]>()
  for (const run of runs) {
    const key = groupKey(run)
    if (key === null) continue
    const bucket = groups.get(key)
    if (bucket) bucket.push(run)
    else groups.set(key, [run])
  }

  const superseded = new Map<number, RunWithRepo>()
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue

    let newest = bucket[0]!
    for (const run of bucket) if (isNewer(run, newest)) newest = run

    for (const run of bucket) {
      if (run.id === newest.id) continue
      if (run.head_sha === newest.head_sha) continue
      if (!isNewer(newest, run)) continue
      superseded.set(run.id, newest)
    }
  }
  return superseded
}
