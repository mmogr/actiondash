/**
 * Query strings for the listings the poller depends on.
 *
 * Kept free of imports so that scripts/probe.mjs can load this file directly
 * and check GitHub's behaviour against the queries the app really sends,
 * rather than against a copy that could drift.
 */

export const RUN_STATUSES = ['queued', 'in_progress'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export function runsQuery(status: string): string {
  return `?status=${status}&per_page=100&exclude_pull_requests=true`
}

export const JOBS_QUERY = '?per_page=100&filter=latest'
