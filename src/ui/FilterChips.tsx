import { repoKey, type RepoRef } from '../github/types'
import { settings } from '../state/settings'
import { buckets, filter, stale } from '../state/store'
import { seriesClass } from './palette'

/**
 * One chip per repository with something running or queued, in watch-list
 * order so the chips do not reorder as the queue moves. The pool figures above
 * the runs are never filtered: the filter narrows what is listed, not what is
 * measured.
 */
export function FilterChips() {
  const active = new Set<string>()
  for (const bucket of buckets.value) {
    for (const j of [...bucket.running, ...bucket.queued]) active.add(repoKey(j.repo).toLowerCase())
  }
  const repos: RepoRef[] = settings.value.repos.filter((r) =>
    active.has(repoKey(r).toLowerCase()),
  )
  const anyStale = stale.value.length > 0
  const current = filter.value

  if (repos.length < 2 && !anyStale) return null

  const chip = (on: boolean, label: preact.ComponentChildren, onClick: () => void) => (
    <button class={`chip${on ? ' on' : ''}`} aria-pressed={on} onClick={onClick}>
      {label}
    </button>
  )

  return (
    <div class="chips" role="group" aria-label="Show">
      {chip(current.repo === null && !current.staleOnly, 'All', () => {
        filter.value = { repo: null, staleOnly: false }
      })}
      {repos.map((repo) => {
        const key = repoKey(repo)
        return chip(
          current.repo === key,
          <>
            <span class={`swatch ${seriesClass(repo)}`} />
            {repo.name}
          </>,
          () => {
            filter.value = { repo: current.repo === key ? null : key, staleOnly: false }
          },
        )
      })}
      {anyStale &&
        chip(current.staleOnly, 'Superseded', () => {
          filter.value = { repo: null, staleOnly: !current.staleOnly }
        })}
    </div>
  )
}
