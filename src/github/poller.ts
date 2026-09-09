import { batch } from '@preact/signals'
import { getBilledCount, getRateLimit, getRetryAfterMs, GitHubError, isRateLimitError } from './client'
import { listJobs, listRuns } from './api'
import { repoKey, type RepoRef, type RunWithRepo, type WorkflowJob } from './types'
import { settings } from '../state/settings'
import {
  effectiveIntervalMs,
  fatalError,
  firstLoadDone,
  jobsByRun,
  lastPoll,
  pollCost,
  polling,
  pollProgress,
  rateLimit,
  rateLimited,
  runs,
  view,
  warning,
} from '../state/store'

/**
 * Polls the configured repositories for active work, within a request budget.
 *
 * A personal access token is allowed 5,000 REST requests an hour. The naive
 * cost of a poll is two run listings per repository plus one job listing per
 * active run, which at a 15-second interval overruns that budget as soon as a
 * dozen runs are genuinely moving. Three things keep it inside:
 *
 *  1. Conditional requests. GitHub does not charge a 304 against the limit, so
 *     a repository with no change costs nothing.
 *  2. Change detection on the run. A run listing already carries updated_at, so
 *     a run whose timestamp has not moved cannot have new job state, and its
 *     job listing is skipped outright rather than merely being cheap. This is
 *     the difference between paying for every active run and paying only for
 *     the ones that actually advanced.
 *  3. Budget-derived pacing. The interval is computed from the measured cost of
 *     the last poll and the budget left before the window resets, so the poll
 *     rate degrades smoothly instead of running the budget to zero and
 *     stopping. The configured interval is a floor, never a promise.
 */

/** Refresh a run's jobs at least this often, even if updated_at has not moved. */
const MAX_JOB_STALENESS_MS = 90_000
/**
 * Waiting longer than the window reset is pointless, because the budget refills
 * then. A small margin puts the next poll just the other side of it.
 */
const RESET_MARGIN_MS = 5_000
/** Absolute sanity bound on any delay the API itself asks for. */
const MAX_RETRY_AFTER_MS = 3_600_000
/** Spend at most this share of the remaining budget before the window resets. */
const BUDGET_SAFETY = 0.6
/**
 * Concurrent job listings. GitHub asks for serial requests to stay clear of the
 * secondary limits, so this is deliberately small.
 */
const JOB_CONCURRENCY = 3
/**
 * Repositories fetched at once. Watching thirty repositories serially made the
 * first load take about twenty seconds, during which the page had nothing to
 * show. A small pool cuts that to a few seconds while staying well clear of the
 * secondary limits.
 */
const REPO_CONCURRENCY = 5
/** Guard against a repository with a pathological number of active runs. */
const MAX_RUNS_PER_REPO = 60

interface JobCacheEntry {
  jobs: WorkflowJob[]
  /** The run's updated_at when these jobs were fetched. */
  updatedAt: string
  fetchedAt: number
}

const jobCache = new Map<number, JobCacheEntry>()

let timer: ReturnType<typeof setTimeout> | null = null
let inFlight: AbortController | null = null
let generation = 0
/** Billed requests consumed by the most recent poll. */
let lastBilled = 1

async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      await fn(items[cursor++]!)
    }
  })
  await Promise.all(workers)
}

function describe(err: unknown, repo: RepoRef): string {
  if (err instanceof GitHubError) {
    if (err.status === 404) {
      return `${repo.owner}/${repo.name} not found. The token may not include this repository.`
    }
    // A rate-limit refusal also arrives as 403. Reported as a permissions
    // problem it would send the reader to the wrong place entirely.
    if (isRateLimitError(err)) {
      return `Request allowance exhausted. Polling pauses until it refills.`
    }
    if (err.status === 403) {
      return `${repo.owner}/${repo.name} refused: ${err.message} Check that the token grants Actions: Read and write.`
    }
    if (err.status === 429) {
      return `Rate limited on ${repo.owner}/${repo.name}. Polling will slow down automatically.`
    }
    return `${repo.owner}/${repo.name}: ${err.message}`
  }
  return `${repo.owner}/${repo.name}: ${(err as Error).message}`
}

/** Drops cached jobs for runs that are no longer active. */
function pruneJobCache(activeRunIds: ReadonlySet<number>): void {
  for (const id of jobCache.keys()) {
    if (!activeRunIds.has(id)) jobCache.delete(id)
  }
}

export async function pollOnce(): Promise<void> {
  const { token, repos } = settings.value
  if (!token || repos.length === 0) return

  inFlight?.abort()
  const controller = new AbortController()
  inFlight = controller
  const mine = ++generation

  polling.value = true
  const billedBefore = getBilledCount()
  const problems: string[] = []
  const byRepo = new Map<string, RunWithRepo[]>()
  let completed = 0
  pollProgress.value = { done: 0, total: repos.length }

  // Progressive publishing is what stops the first load looking broken, but on
  // a refresh it would make rows vanish and reappear as each repository is
  // replaced. Only the initial load fills in piecewise; later polls swap in one
  // step, once everything has been gathered.
  const publishAsWeGo = !firstLoadDone.value

  /**
   * Pushes what has been gathered so far into the store.
   */
  const publish = (): void => {
    if (mine !== generation) return
    const all = [...byRepo.values()].flat()
    const jobs = new Map<number, WorkflowJob[]>()
    for (const run of all) {
      const cached = jobCache.get(run.id)
      if (cached) jobs.set(run.id, cached.jobs)
    }
    batch(() => {
      runs.value = all
      jobsByRun.value = jobs
      rateLimit.value = getRateLimit()
    })
  }

  const fetchJobsFor = async (repoRuns: readonly RunWithRepo[]): Promise<void> => {
    const now = Date.now()
    const needed = repoRuns.filter((run) => {
      const cached = jobCache.get(run.id)
      if (!cached) return true
      if (cached.updatedAt !== run.updated_at) return true
      return now - cached.fetchedAt > MAX_JOB_STALENESS_MS
    })
    await mapLimit(needed, JOB_CONCURRENCY, async (run) => {
      try {
        const list = await listJobs({ owner: run.repoOwner, name: run.repoName }, run.id)
        jobCache.set(run.id, { jobs: list, updatedAt: run.updated_at, fetchedAt: Date.now() })
      } catch (err) {
        if (err instanceof GitHubError && err.status === 401) throw err
        // A run that finished between the two calls answers 404. Recording it
        // as empty is correct: it is no longer holding a slot.
        jobCache.set(run.id, { jobs: [], updatedAt: run.updated_at, fetchedAt: Date.now() })
      }
    })
  }

  try {
    await mapLimit(repos, REPO_CONCURRENCY, async (repo) => {
      if (controller.signal.aborted || mine !== generation) return
      try {
        const [queued, running] = await Promise.all([
          listRuns(repo, 'queued'),
          listRuns(repo, 'in_progress'),
        ])
        const repoRuns = [...queued, ...running].slice(0, MAX_RUNS_PER_REPO)
        await fetchJobsFor(repoRuns)
        byRepo.set(repoKey(repo), repoRuns)
      } catch (err) {
        if (err instanceof GitHubError && err.status === 401) throw err
        if (isRateLimitError(err)) throw err
        problems.push(describe(err, repo))
      } finally {
        completed++
        if (mine === generation) {
          pollProgress.value = { done: completed, total: repos.length }
          if (publishAsWeGo) publish()
        }
      }
    })

    if (controller.signal.aborted || mine !== generation) return

    pruneJobCache(new Set([...byRepo.values()].flat().map((r) => r.id)))
    lastBilled = Math.max(1, getBilledCount() - billedBefore)

    publish()
    batch(() => {
      lastPoll.value = Date.now()
      pollCost.value = lastBilled
      firstLoadDone.value = true
      rateLimited.value = null
      warning.value = problems.length > 0 ? problems.join(' ') : null
      fatalError.value = null
    })
  } catch (err) {
    if (controller.signal.aborted) return
    if (err instanceof GitHubError && err.status === 401) {
      batch(() => {
        fatalError.value = 'The token was rejected. It may have expired or been revoked.'
        view.value = 'setup'
      })
      stopPolling()
      return
    }
    if (isRateLimitError(err)) {
      const limit = getRateLimit()
      batch(() => {
        rateLimited.value = limit ? limit.reset : null
        firstLoadDone.value = true
      })
      return
    }
    batch(() => {
      fatalError.value = (err as Error).message
      firstLoadDone.value = true
    })
  } finally {
    if (mine === generation) polling.value = false
  }
}

export interface PacingInput {
  /** The interval the user configured. Acts as a floor. */
  baseMs: number
  /** Requests left in the current window, or null when not yet known. */
  remaining: number | null
  /** Unix seconds at which the window resets. */
  resetEpochSec: number
  /** Rate-limited requests the last poll consumed. */
  billedPerPoll: number
  /** A retry-after or x-poll-interval the API asked for, in ms. */
  retryAfterMs: number
  nowMs: number
}

/**
 * The delay before the next poll.
 *
 * Spreads at most BUDGET_SAFETY of the remaining requests across the time left
 * in the window, so the dashboard cannot spend its way to a hard stop. The
 * configured interval is a floor: when the budget is comfortable, that is what
 * gets used, and the pacing is invisible.
 */
export function computeInterval(input: PacingInput): number {
  const { baseMs, remaining, resetEpochSec, billedPerPoll, retryAfterMs, nowMs } = input

  // An explicit instruction from the API wins outright.
  if (retryAfterMs > 0) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(baseMs, retryAfterMs))
  }

  if (remaining === null) return baseMs

  // Waiting beyond the reset buys nothing, since the allowance refills there.
  const msToReset = Math.max(0, resetEpochSec * 1000 - nowMs)
  const ceiling = Math.max(baseMs, msToReset + RESET_MARGIN_MS)

  if (remaining <= 0) return ceiling

  const billed = Math.max(1, billedPerPoll)
  const secondsToReset = Math.max(60, resetEpochSec - nowMs / 1000)
  const affordablePolls = (remaining * BUDGET_SAFETY) / billed
  if (affordablePolls <= 0) return ceiling

  const requiredMs = (secondsToReset / affordablePolls) * 1000
  return Math.min(ceiling, Math.max(baseMs, requiredMs))
}

function nextInterval(): number {
  const limit = getRateLimit()
  return computeInterval({
    baseMs: settings.value.pollIntervalMs,
    remaining: limit ? limit.remaining : null,
    resetEpochSec: limit ? limit.reset : 0,
    billedPerPoll: lastBilled,
    retryAfterMs: getRetryAfterMs(),
    nowMs: Date.now(),
  })
}

function schedule(): void {
  if (timer !== null) clearTimeout(timer)
  const delay = nextInterval()
  effectiveIntervalMs.value = delay
  timer = setTimeout(() => {
    void pollOnce().finally(schedule)
  }, delay)
}

export function startPolling(): void {
  stopPolling()
  void pollOnce().finally(schedule)
}

export function stopPolling(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  inFlight?.abort()
  inFlight = null
  generation++
  polling.value = false
}

/** Clears cached job data, so the next poll refetches everything. */
export function clearJobCache(): void {
  jobCache.clear()
  lastBilled = 1
}
