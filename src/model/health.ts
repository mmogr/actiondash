import { GitHubError, isRateLimitError } from '../github/client'

/**
 * Whether the dashboard actually heard from GitHub, per repository. The rule
 * behind all of it: a repository that could not be checked is never shown as
 * empty, and the page never says "All clear" unless every one answered.
 *
 * Pure; the poller and the store hold the state.
 */

/** Keep showing a repository's last good answer for this long after it stops answering. */
export const SNAPSHOT_MAX_AGE_MS = 10 * 60_000

/**
 * Why a repository could not be checked. "missing" and "denied" are answers,
 * not outages: the token cannot see the repository, and asking again will not
 * change that.
 */
export type Problem = 'missing' | 'denied' | 'server' | 'network' | 'other'

export interface RepoProblem {
  problem: Problem
  /** GitHub's own message, for the tooltip. */
  detail: string
  /** When this repository first failed in the current run of failures. */
  since: number
  /** When the rows shown for it were read, or null when none are shown. */
  asOf: number | null
}

/**
 * The state of the data as a whole.
 * - ok: every repository answered on the last poll
 * - partial: some did not
 * - unreachable: none did
 * - offline: the device has no network, so nothing was asked
 * - limited: the hourly allowance is used up, so nothing is being asked
 * - none: no poll has finished yet
 */
export type DataHealth = 'ok' | 'partial' | 'unreachable' | 'offline' | 'limited' | 'none'

export function classify(err: unknown): Problem {
  if (err instanceof GitHubError) {
    if (err.status === 404) return 'missing'
    if (err.status === 403 && !isRateLimitError(err)) return 'denied'
    if (err.status >= 500) return 'server'
    return 'other'
  }
  // Anything that never produced an HTTP status: no network, DNS, a reset.
  return err instanceof TypeError ? 'network' : 'other'
}

/** Plain words for a problem, as it would be said to the reader. */
export function problemText(problem: Problem): string {
  switch (problem) {
    case 'missing':
      return 'not found; the token may not include it'
    case 'denied':
      return 'refused; the token needs Actions: Read and write'
    case 'server':
      return 'GitHub had a server error'
    case 'network':
      return 'no response from GitHub'
    case 'other':
      return 'GitHub returned an error'
  }
}

/**
 * Whether a repository's last good runs may stand in for it. Not after it said
 * it does not exist or will not answer, and not once the answer is old enough
 * that the runs in it have probably finished.
 */
export function snapshotUsable(problem: Problem, at: number, nowMs: number): boolean {
  if (problem === 'missing' || problem === 'denied') return false
  return nowMs - at <= SNAPSHOT_MAX_AGE_MS
}

export function dataHealthOf(input: {
  online: boolean
  limited: boolean
  loaded: boolean
  repoCount: number
  problems: ReadonlyMap<string, RepoProblem>
}): DataHealth {
  if (!input.online) return 'offline'
  if (input.limited) return 'limited'
  if (!input.loaded) return 'none'
  if (input.problems.size === 0) return 'ok'
  return input.problems.size >= input.repoCount ? 'unreachable' : 'partial'
}

/**
 * Whether a poll saw everything it could see: some repository answered, and
 * any that did not said it never will. A poll like that is a true picture of
 * the watched pools, so it is fit to record and to compare against the last.
 * Without the second half, one repository removed from the token would stop
 * history and alerts for good.
 */
export function isComplete(repoCount: number, problems: ReadonlyMap<string, RepoProblem>): boolean {
  if (problems.size >= repoCount) return false
  for (const p of problems.values()) {
    if (p.problem !== 'missing' && p.problem !== 'denied') return false
  }
  return true
}
