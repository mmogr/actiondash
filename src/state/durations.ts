import { signal } from '@preact/signals'
import type { RepoRef, WorkflowJob } from '../github/types'
import { recordCompleted, sanitiseDurations, type DurationMap } from '../model/durations'

/**
 * Learned job durations, persisted so the forecast is useful from the first
 * poll after a reload rather than an hour later. Holds no secrets: repository
 * and job names, seconds and job ids.
 */

export const DURATIONS_KEY = 'actiondash.durations.v1'

function load(): DurationMap {
  try {
    const raw = localStorage.getItem(DURATIONS_KEY)
    return raw ? sanitiseDurations(JSON.parse(raw)) : {}
  } catch {
    return {}
  }
}

export const durations = signal<DurationMap>(load())

function persist(map: DurationMap): void {
  try {
    localStorage.setItem(DURATIONS_KEY, JSON.stringify(map))
  } catch {
    // Storage unavailable. The session still learns; it just forgets on reload.
  }
}

/** Learns from any completed jobs in the list. Writes storage only when something new was seen. */
export function learnDurations(repo: RepoRef, jobs: readonly WorkflowJob[], nowMs = Date.now()): void {
  const next = recordCompleted(durations.value, repo, jobs, nowMs)
  if (next === durations.value) return
  durations.value = next
  persist(next)
}

export function clearDurations(): void {
  durations.value = {}
  try {
    localStorage.removeItem(DURATIONS_KEY)
  } catch {
    // Nothing to remove.
  }
}
