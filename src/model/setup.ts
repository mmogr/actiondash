import { repoKey, type RepoRef } from '../github/types'

/** Decisions behind the setup screen, kept pure so they can be tested. */

/** The accounts behind a selection of owner/name keys, largest first. */
export function ownersOf(keys: Iterable<string>): { owner: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const key of keys) {
    const owner = key.split('/')[0] ?? key
    counts.set(owner, (counts.get(owner) ?? 0) + 1)
  }
  return [...counts]
    .map(([owner, count]) => ({ owner, count }))
    .sort((a, b) => b.count - a.count || a.owner.localeCompare(b.owner))
}

/** Whether a selection is the watch list as stored, ignoring order and case. */
export function sameSelection(stored: readonly RepoRef[], selected: ReadonlySet<string>): boolean {
  const a = new Set(stored.map((r) => repoKey(r).toLowerCase()))
  const b = new Set([...selected].map((k) => k.toLowerCase()))
  return a.size === b.size && [...a].every((k) => b.has(k))
}

/**
 * Whether a new token belongs to the account the old one did, so recovery can
 * go straight back to the dashboard. A browser that never kept the login
 * cannot tell, and treats it as the same once the repositories check out.
 */
export function sameAccount(storedLogin: string | null, newLogin: string): boolean {
  return storedLogin === null || storedLogin.toLowerCase() === newLogin.toLowerCase()
}

/** What a rejected token leaves in place, in words. */
export function keptList(input: {
  repoCount: number
  planLabel: string
  learnedJobs: number
  hasHistory: boolean
}): string[] {
  const kept = [
    `${input.repoCount} ${input.repoCount === 1 ? 'repository' : 'repositories'}`,
    `the ${input.planLabel} plan`,
  ]
  if (input.learnedJobs > 0) {
    kept.push(`learned durations for ${input.learnedJobs} job${input.learnedJobs === 1 ? '' : 's'}`)
  }
  if (input.hasHistory) kept.push('occupancy history')
  return kept
}

/** "a", "a and b", "a, b and c". */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}
