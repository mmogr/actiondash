import { computed, signal } from '@preact/signals'
import type { RunWithRepo, WorkflowJob } from '../github/types'
import type { RateLimit } from '../github/client'
import { buildBuckets, staleJobs } from '../model/queue'
import { NO_FILTER, type ViewFilter } from '../model/filter'
import { PLANS } from '../model/plans'
import { settings } from './settings'

export type View = 'setup' | 'dashboard'

export const view = signal<View>(
  settings.value.token && settings.value.repos.length > 0 ? 'dashboard' : 'setup',
)

/** Which screen of the dashboard is showing. Session-only: a reload lands on Now. */
export type Tab = 'now' | 'trends' | 'alerts' | 'settings'
export const tab = signal<Tab>('now')

/** The reader's narrowing of the run list. Session-only for the same reason. */
export const filter = signal<ViewFilter>(NO_FILTER)

export const runs = signal<RunWithRepo[]>([])
export const jobsByRun = signal<Map<number, WorkflowJob[]>>(new Map())

export const polling = signal(false)
/** False until the first poll has finished, so the UI never claims "nothing" too early. */
export const firstLoadDone = signal(false)
/** Repositories checked so far in the current poll, for the loading indicator. */
export const pollProgress = signal<{ done: number; total: number }>({ done: 0, total: 0 })
/** Set when the request allowance is exhausted; carries the reset time. */
export const rateLimited = signal<number | null>(null)
export const lastPoll = signal<number | null>(null)
export const rateLimit = signal<RateLimit | null>(null)

/** Rate-limited requests consumed by the most recent poll. */
export const pollCost = signal(0)
/** The delay actually being used, which the budget may stretch past the setting. */
export const effectiveIntervalMs = signal(0)

/**
 * Requests per hour at the current cost and cadence. This is the number that
 * decides whether the dashboard fits inside the 5,000 an hour a token gets.
 */
export const projectedHourlyCost = computed(() => {
  const interval = effectiveIntervalMs.value
  if (interval <= 0) return 0
  return Math.round(pollCost.value * (3_600_000 / interval))
})

/** Fatal, blocks the view. */
export const fatalError = signal<string | null>(null)
/** Transient, shown as a dismissible banner. */
export const warning = signal<string | null>(null)
/**
 * Set when the reader dismisses the suspect-observation banner. Session-only on
 * purpose: the underlying figure rebuilds from the next few polls, so silencing
 * it for good belongs to clearing the observation, not to hiding the notice.
 */
export const observationDismissed = signal(false)

/** Ticks once a second so relative ages re-render without a re-poll. */
export const now = signal(Date.now())

export const buckets = computed(() =>
  buildBuckets(runs.value, jobsByRun.value, PLANS[settings.value.plan]),
)

export const stale = computed(() => staleJobs(buckets.value))

export const totalQueued = computed(() =>
  buckets.value.reduce((sum, b) => sum + b.queued.length, 0),
)

export const totalRunning = computed(() =>
  buckets.value.reduce((sum, b) => sum + b.running.length, 0),
)

export function resetData(): void {
  runs.value = []
  jobsByRun.value = new Map()
  lastPoll.value = null
  rateLimit.value = null
  pollCost.value = 0
  effectiveIntervalMs.value = 0
  firstLoadDone.value = false
  pollProgress.value = { done: 0, total: 0 }
  rateLimited.value = null
  fatalError.value = null
  warning.value = null
  observationDismissed.value = false
  tab.value = 'now'
  filter.value = NO_FILTER
}
