import { signal } from '@preact/signals'
import type { ClassBucket } from '../model/queue'
import { EMPTY_HISTORY, record, sanitiseHistory, type HistoryState } from '../model/history'

/**
 * Occupancy history, persisted so the Trends screen survives a reload. Holds
 * no secrets: counts, timestamps and repository names.
 */

export const HISTORY_KEY = 'actiondash.history.v1'

function load(): HistoryState {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    return raw ? sanitiseHistory(JSON.parse(raw)) : EMPTY_HISTORY
  } catch {
    return EMPTY_HISTORY
  }
}

export const history = signal<HistoryState>(load())

/** Records one poll. Written once per poll, which is the slowest it can be and still be a record. */
export function recordHistory(buckets: readonly ClassBucket[], nowMs: number, intervalMs: number): void {
  const next = record(history.value, buckets, nowMs, intervalMs)
  history.value = next
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
  } catch {
    // Storage unavailable or full. The session still shows what it saw.
  }
}

export function clearHistory(): void {
  history.value = EMPTY_HISTORY
  try {
    localStorage.removeItem(HISTORY_KEY)
  } catch {
    // Nothing to remove.
  }
}
