import { repoKey } from '../github/types'
import { isMine } from './mine'
import type { RunGroup } from './queue'

/** What the reader has narrowed the view to. The pool figures are never filtered. */
export interface ViewFilter {
  /** owner/name of the one repository to show, or null for all. */
  repo: string | null
  /** Show only runs that a newer run has made pointless. */
  staleOnly: boolean
  /** Show only the reader's own runs. */
  mine: boolean
}

export const NO_FILTER: ViewFilter = { repo: null, staleOnly: false, mine: false }

export function matchesFilter(group: RunGroup, filter: ViewFilter, login: string | null = null): boolean {
  if (filter.staleOnly && group.supersededBy === null) return false
  if (filter.mine && !isMine(group.run, login)) return false
  if (filter.repo !== null && repoKey(group.repo).toLowerCase() !== filter.repo.toLowerCase()) {
    return false
  }
  return true
}
