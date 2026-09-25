import { repoKey } from '../github/types'
import type { RunGroup } from './queue'

/** What the reader has narrowed the view to. The pool figures are never filtered. */
export interface ViewFilter {
  /** owner/name of the one repository to show, or null for all. */
  repo: string | null
  /** Show only runs that a newer run has made pointless. */
  staleOnly: boolean
}

export const NO_FILTER: ViewFilter = { repo: null, staleOnly: false }

export function matchesFilter(group: RunGroup, filter: ViewFilter): boolean {
  if (filter.staleOnly && group.supersededBy === null) return false
  if (filter.repo !== null && repoKey(group.repo).toLowerCase() !== filter.repo.toLowerCase()) {
    return false
  }
  return true
}
