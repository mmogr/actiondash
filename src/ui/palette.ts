import { repoKey, type RepoRef } from '../github/types'
import { settings } from '../state/settings'

/** Distinct colours available before repositories fall back to grey. */
export const SERIES_COUNT = 8

/**
 * The palette slot of a watched repository, 1 to SERIES_COUNT, or 0 for grey.
 *
 * The slot follows the repository's place in the watch list rather than its
 * place in whatever is on screen, so a repository keeps its colour while others
 * come and go. Colours never carry meaning alone: every use sits next to the
 * repository's name.
 */
export function seriesOf(repo: RepoRef): number {
  const key = repoKey(repo).toLowerCase()
  const i = settings.value.repos.findIndex((r) => repoKey(r).toLowerCase() === key)
  return i >= 0 && i < SERIES_COUNT ? i + 1 : 0
}

export function seriesClass(repo: RepoRef): string {
  return `series-${seriesOf(repo)}`
}
