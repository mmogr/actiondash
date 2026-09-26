import { computed, signal } from '@preact/signals'
import type { RunnerClass, RunWithRepo, WorkflowJob } from '../github/types'
import type { RateLimit } from '../github/client'
import { buildBuckets, staleJobs } from '../model/queue'
import { forecastBucket, insightFor, type BucketForecast, type Insight } from '../model/forecast'
import { NO_FILTER, type ViewFilter } from '../model/filter'
import { dataHealthOf, isComplete, type RepoProblem } from '../model/health'
import { myRuns } from '../model/mine'
import type { FinishedRun } from '../model/finished'
import type { PacingReason } from '../model/status'
import { PLANS } from '../model/plans'
import { settings } from './settings'
import { durations } from './durations'

export type View = 'setup' | 'dashboard'

export const view = signal<View>(
  settings.value.token && settings.value.repos.length > 0 && settings.value.tokenRejectedAt === null
    ? 'dashboard'
    : 'setup',
)

/** Which screen of the dashboard is showing. Kept in the address, so a reload stays put. */
export type Tab = 'now' | 'trends' | 'alerts' | 'settings'
export const tab = signal<Tab>('now')

/** A run a link or a notification asked to show, until the Now screen has shown it. */
export const pendingRun = signal<number | null>(null)

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
/** Why that delay is what it is. */
export const pacingReason = signal<PacingReason>('floor')
/** When the next poll is due, or null while polling is stopped. */
export const nextPollAt = signal<number | null>(null)

/** False while the browser reports no network. Nothing is asked of GitHub then. */
export const online = signal(typeof navigator === 'undefined' || navigator.onLine !== false)

/** Repositories that did not answer the last poll, by owner/name. */
export const repoProblems = signal<Map<string, RepoProblem>>(new Map())
/**
 * Runs shown from an older answer than the last poll's, with when that answer
 * was read. A repository that stops answering keeps its last good runs for a
 * while, marked, rather than having them vanish as if they had finished.
 */
export const runsAsOf = signal<Map<number, number>>(new Map())

/** Runs this page saw finish, newest first. Session-only. */
export const recentlyFinished = signal<FinishedRun[]>([])
/**
 * Runs cancelled from this page, with when. GitHub takes a moment to reflect a
 * cancel, and a row whose button came straight back would invite a second one.
 */
export const cancelRequested = signal<Map<number, number>>(new Map())

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
/**
 * A cancel or re-run the reader asked for that did not go through. Kept apart
 * from the poll's own messages so the next poll cannot wipe it before it is read.
 */
export const actionError = signal<string | null>(null)
/**
 * Set when the reader dismisses the suspect-observation banner. Session-only on
 * purpose: the underlying figure rebuilds from the next few polls, so silencing
 * it for good belongs to clearing the observation, not to hiding the notice.
 */
export const observationDismissed = signal(false)

/** Trends range, as an index into its range list, kept across tab switches. */
export const trendsRange = signal(1)
/** The pool Trends is drawing, or null for the scarce one. */
export const trendsPool = signal<RunnerClass | null>(null)

/** Ticks once a second so relative ages re-render without a re-poll. */
export const now = signal(Date.now())

export const buckets = computed(() =>
  buildBuckets(runs.value, jobsByRun.value, PLANS[settings.value.plan]),
)

export const stale = computed(() => staleJobs(buckets.value))

/** Whether the page is showing what GitHub says now, and if not, why not. */
export const dataHealth = computed(() =>
  dataHealthOf({
    online: online.value,
    limited: rateLimited.value !== null,
    loaded: firstLoadDone.value,
    repoCount: settings.value.repos.length,
    problems: repoProblems.value,
  }),
)

/** True when the last poll saw every repository it could see. */
export const pollComplete = computed(() => {
  const health = dataHealth.value
  if (health === 'ok') return true
  return health === 'partial' && isComplete(settings.value.repos.length, repoProblems.value)
})

/**
 * When every row on the page was last read, while nothing is being read at
 * all: offline, or out of allowance. A repository that is asked but does not
 * answer marks its own rows instead; see runsAsOf.
 */
export const frozenAt = computed(() => {
  const health = dataHealth.value
  return health === 'offline' || health === 'limited' ? lastPoll.value : null
})

/**
 * Forecasts and the insight, by runner class. Recomputed as the clock ticks so
 * a running job's expected end never slips into the past.
 */
export const forecasts = computed(() => {
  const map = new Map<string, { forecast: BucketForecast; insight: Insight | null }>()
  for (const bucket of buckets.value) {
    map.set(bucket.cls, {
      forecast: forecastBucket(bucket, durations.value, now.value),
      insight: bucket.cap === null ? null : insightFor(bucket, durations.value, now.value),
    })
  }
  return map
})

/** The reader's own active runs, running first. */
export const myRunsNow = computed(() =>
  myRuns(buckets.value, forecasts.value, jobsByRun.value, settings.value.login),
)

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
  repoProblems.value = new Map()
  runsAsOf.value = new Map()
  recentlyFinished.value = []
  cancelRequested.value = new Map()
  firstLoadDone.value = false
  pollProgress.value = { done: 0, total: 0 }
  rateLimited.value = null
  fatalError.value = null
  actionError.value = null
  observationDismissed.value = false
  trendsRange.value = 1
  trendsPool.value = null
  tab.value = 'now'
  filter.value = NO_FILTER
}
