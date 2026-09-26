import { batch } from '@preact/signals'
import {
  getBilledCount,
  getRateLimit,
  getRetryAfterMs,
  GitHubError,
  isRateLimitError,
  resetRetryAfter,
} from './client'
import { listJobs, listRuns } from './api'
import { repoKey, type RunWithRepo, type WorkflowJob } from './types'
import { settings, updateSettings } from '../state/settings'
import { learnDurations } from '../state/durations'
import { recordHistory } from '../state/history'
import { PLANS, type ObservedMax } from '../model/plans'
import { buildBuckets } from '../model/queue'
import { classify, isComplete, snapshotUsable, type Problem, type RepoProblem } from '../model/health'
import { addFinished, CANCEL_REQUEST_TTL_MS, classifyFinished, type FinishedRun } from '../model/finished'
import { refreshBlock, type PacingReason, type RefreshBlock } from '../model/status'
import {
  buckets,
  cancelRequested,
  effectiveIntervalMs,
  fatalError,
  firstLoadDone,
  jobsByRun,
  lastPoll,
  nextPollAt,
  online,
  pacingReason,
  pollCost,
  polling,
  pollProgress,
  rateLimit,
  rateLimited,
  recentlyFinished,
  repoProblems,
  runs,
  runsAsOf,
  view,
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
 * How recent a job snapshot has to be to count as evidence about the account's
 * concurrency ceiling. Far tighter than MAX_JOB_STALENESS_MS, because showing a
 * slightly stale row is a small cosmetic cost while asserting a billing tier
 * from a blend of moments a minute apart is not a measurement at all.
 *
 * A stale row is not always cosmetic, though: jobs that have finished since
 * still count as running, and beside newer runs that can show a pool over its
 * own ceiling. A pool reading over its ceiling therefore has its older
 * snapshots refetched before it is shown; see remeasureOverCap.
 */
const SAMPLE_MAX_AGE_MS = 20_000
/** Consecutive polls that must agree before a new high-water mark is believed. */
export const CONFIRMING_POLLS = 3
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
/**
 * Below this many requests left in the hour, a finished run's final job
 * listing is not worth what it costs. The listing only teaches durations; the
 * dashboard itself must keep polling.
 */
const LEARNING_MIN_REMAINING = 200

/**
 * Merges the two status listings into one run list, keeping each run once.
 *
 * The two listings are separate requests, not one snapshot, so a run that
 * changes status between them can legitimately appear in both. That is the
 * reason for the dedupe, and it is defensive rather than a known cause of
 * miscounting.
 *
 * GitHub's documentation says the `status` filter matches a run's check runs,
 * which would suggest a partly started run comes back from both listings. It
 * does not appear to: checked on 2026-09-21 across nodejs/node, elastic/kibana,
 * home-assistant/core, rust-lang/rust and microsoft/vscode, about 378 active
 * runs showed no run in both listings, and every run's own status matched the
 * filter that returned it.
 *
 * The inflated macOS count this once blamed on that overlap has four candidate
 * causes, and only the last has been reproduced:
 * 1. filter overlap between the listings (documented, not observed);
 * 2. a run changing status between the two requests (handled here);
 * 3. one repository watched under two spellings (handled by job id in
 *    buildBuckets, since repoKey does not normalise case);
 * 4. job snapshots between SAMPLE_MAX_AGE_MS and MAX_JOB_STALENESS_MS old
 *    counted alongside fresh ones, so jobs that finished since still count as
 *    running. Contemporaneity keeps that out of observedMax, and
 *    remeasureOverCap keeps it off a meter that would read over its ceiling.
 *
 * The in_progress copy wins, because it carries the fresher updated_at that the
 * job cache's staleness test depends on. Running runs are listed first so that
 * MAX_RUNS_PER_REPO truncates the waiting tail rather than the work that is
 * actually holding a slot.
 */
export function mergeRunLists(
  queued: readonly RunWithRepo[],
  running: readonly RunWithRepo[],
  limit: number,
): RunWithRepo[] {
  const byId = new Map<number, RunWithRepo>()
  for (const run of running) byId.set(run.id, run)
  for (const run of queued) if (!byId.has(run.id)) byId.set(run.id, run)
  return [...byId.values()].slice(0, limit)
}

interface JobCacheEntry {
  jobs: WorkflowJob[]
  /** The run's updated_at when these jobs were fetched. */
  updatedAt: string
  fetchedAt: number
}

const jobCache = new Map<number, JobCacheEntry>()

/**
 * Each repository's last good run listing and when it was read. While a
 * repository cannot be checked, this stands in for it, marked, so its runs do
 * not vanish as if they had finished.
 */
const lastGood = new Map<string, { runs: RunWithRepo[]; at: number }>()
/** When each repository now failing first failed. */
const failingSince = new Map<string, number>()

let timer: ReturnType<typeof setTimeout> | null = null
let inFlight: AbortController | null = null
let generation = 0
/** Billed requests consumed by the most recent poll. */
let lastBilled = 1
/** When the most recent poll started, to space refreshes on demand. */
let lastStartedAt: number | null = null
/**
 * True between startPolling and stopPolling. A 401 stops polling from inside
 * a poll whose own finally would otherwise schedule the next one.
 */
let started = false

/**
 * Runs fn over items, at most limit at a time, and stops handing out items at
 * the first rejection. Promise.all rejecting does not stop the other workers,
 * and a rejection here is a 401 or a rate-limit refusal, after which every
 * further request is one the dashboard has already said it will not make.
 */
async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  let failed = false
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && cursor < items.length) {
      try {
        await fn(items[cursor++]!)
      } catch (err) {
        failed = true
        throw err
      }
    }
  })
  await Promise.all(workers)
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The last few samples, deliberately not persisted: a reload starts over. */
const recentSamples: ObservedMax[] = []

/**
 * The new high-water marks that every sample in the window supports, or null
 * when nothing beats what is already recorded.
 *
 * A high-water mark is a claim about a ceiling and it never comes back down, so
 * a single bad sample is permanent. Taking the weakest reading across
 * consecutive polls means a transient figure has to persist before it is
 * believed, while a real ceiling - which an account at its limit reaches again
 * and again - still registers within a minute.
 */
export function promoteObserved(
  samples: readonly ObservedMax[],
  previous: ObservedMax,
): ObservedMax | null {
  if (samples.length === 0) return null

  const keys = new Set<keyof ObservedMax>()
  for (const sample of samples) {
    for (const key of Object.keys(sample)) keys.add(key as keyof ObservedMax)
  }

  const next: ObservedMax = { ...previous }
  let changed = false
  for (const key of keys) {
    let agreed = Infinity
    for (const sample of samples) agreed = Math.min(agreed, sample[key] ?? 0)
    if (agreed > (next[key] ?? 0)) {
      next[key] = agreed
      changed = true
    }
  }
  return changed ? next : null
}

/**
 * Records the most jobs seen running at once, which is the only evidence
 * available for the account's real concurrency ceiling.
 *
 * Only called for a poll whose job data is contemporaneous, and only believed
 * once consecutive polls agree, because the figure it writes is permanent.
 */
function recordObserved(): void {
  // The ceiling belongs to the account that owns each repository, so a figure
  // summed across several owners adds together pools GitHub meters separately.
  // The README already warns that the meters are not meaningful in that
  // configuration; a plan suggestion must not be manufactured out of it either.
  if (new Set(settings.value.repos.map((r) => r.owner)).size > 1) return

  const sample: ObservedMax = {}
  let total = 0
  for (const bucket of buckets.value) {
    // A class with no published ceiling is no evidence about the plan's. capFor
    // already says self-hosted capacity is the operator's own, and that the
    // pool behind 'other' cannot be inferred at all.
    if (bucket.cap === null) continue
    sample[bucket.cls] = bucket.running.length
    total += bucket.running.length
  }
  sample.total = total

  recentSamples.push(sample)
  while (recentSamples.length > CONFIRMING_POLLS) recentSamples.shift()
  if (recentSamples.length < CONFIRMING_POLLS) return

  const next = promoteObserved(recentSamples, settings.value.observedMax)
  // Only written when a new high is set, so a steady poll does not keep
  // rewriting local storage.
  if (next) updateSettings({ observedMax: next })
}

interface Removed {
  id: number
  /** The run's last cached jobs. */
  jobs: WorkflowJob[]
  /**
   * Its last snapshot still showed work in flight, so it finished between two
   * polls and how it ended was never seen.
   */
  unfinished: boolean
}

/** Drops cached jobs for runs that are no longer active, and returns what was dropped. */
function pruneJobCache(activeRunIds: ReadonlySet<number>): Removed[] {
  const removed: Removed[] = []
  for (const [id, entry] of jobCache) {
    if (activeRunIds.has(id)) continue
    removed.push({ id, jobs: entry.jobs, unfinished: entry.jobs.some((job) => job.status !== 'completed') })
    jobCache.delete(id)
  }
  return removed
}

/** Teaches the duration store every completed job currently cached. */
function learnFromCache(): void {
  const byRun = new Map(runs.value.map((run) => [run.id, run]))
  for (const [id, entry] of jobCache) {
    const run = byRun.get(id)
    if (run) learnDurations({ owner: run.repoOwner, name: run.repoName }, entry.jobs)
  }
}

/**
 * Fetches the final job listing of runs that finished since the last poll, so
 * their durations are learned and how they ended is known. One request per
 * run, and only while the hourly allowance is comfortable: the forecast is a
 * convenience, the dashboard is not. Returns the listings it got.
 */
async function learnFinishedRuns(
  finished: readonly RunWithRepo[],
  signal: AbortSignal,
): Promise<Map<number, WorkflowJob[]>> {
  const finals = new Map<number, WorkflowJob[]>()
  if (finished.length === 0) return finals
  const remaining = getRateLimit()?.remaining
  if (remaining !== undefined && remaining < LEARNING_MIN_REMAINING) return finals
  await mapLimit(finished, JOB_CONCURRENCY, async (run) => {
    const repo = { owner: run.repoOwner, name: run.repoName }
    try {
      const jobs = await listJobs(repo, run.id, { signal })
      finals.set(run.id, jobs)
      learnDurations(repo, jobs)
    } catch (err) {
      // Learning is best effort. Only the failures that mean the poll as a
      // whole must stop are allowed through.
      if (err instanceof GitHubError && err.status === 401) throw err
      if (isRateLimitError(err)) throw err
    }
  })
  return finals
}

export async function pollOnce(): Promise<void> {
  const { token, repos } = settings.value
  if (!token || repos.length === 0) return
  // Offline, every request would fail and every repository would read as down.
  // Nothing is asked; the page says it is offline and waits.
  if (!online.peek()) return

  inFlight?.abort()
  lastStartedAt = Date.now()
  const controller = new AbortController()
  inFlight = controller
  const mine = ++generation

  polling.value = true
  resetRetryAfter()
  const billedBefore = getBilledCount()
  const problems = new Map<string, { problem: Problem; detail: string }>()
  const byRepo = new Map<string, RunWithRepo[]>()
  // Runs shown from an older answer, with when it was read.
  const asOf = new Map<number, number>()
  // Repositories standing in with their last good listing, and when it was read.
  const standIns = new Map<string, number>()
  // Runs of repositories that did not answer. Not seen does not mean finished,
  // so their cached jobs are kept and nothing is spent learning them.
  const keep = new Set<number>()
  let completed = 0
  pollProgress.value = { done: 0, total: repos.length }

  // Progressive publishing is what stops the first load looking broken, but on
  // a refresh it would make rows vanish and reappear as each repository is
  // replaced. Only the initial load fills in piecewise; later polls swap in one
  // step, once everything has been gathered.
  const publishAsWeGo = !firstLoadDone.value

  // Cleared when the poll reuses a job snapshot older than the sampling window.
  // Such a poll still renders correctly, but it is a blend of moments rather
  // than a picture of one, so it does not get a vote on the ceiling.
  let contemporaneous = true

  /**
   * Pushes what has been gathered so far into the store.
   */
  const cachedJobs = (all: readonly RunWithRepo[]): Map<number, WorkflowJob[]> => {
    const jobs = new Map<number, WorkflowJob[]>()
    for (const run of all) {
      const cached = jobCache.get(run.id)
      if (cached) jobs.set(run.id, cached.jobs)
    }
    return jobs
  }

  const publish = (): void => {
    if (mine !== generation) return
    const all = [...byRepo.values()].flat()
    const jobs = cachedJobs(all)
    batch(() => {
      runs.value = all
      jobsByRun.value = jobs
      runsAsOf.value = new Map(asOf)
      rateLimit.value = getRateLimit()
    })
  }

  const fetchJobs = async (run: RunWithRepo): Promise<void> => {
    try {
      const list = await listJobs({ owner: run.repoOwner, name: run.repoName }, run.id, {
        signal: controller.signal,
      })
      // A newer poll may have started, and cached fresher jobs, while this
      // listing was on its way back. The cache outlives the poll, so the
      // check publish() makes is needed here too.
      if (mine !== generation) return
      jobCache.set(run.id, { jobs: list, updatedAt: run.updated_at, fetchedAt: Date.now() })
    } catch (err) {
      if (mine !== generation) return
      // A run that finished between the two calls answers 404. Recording it
      // as empty is correct: it is no longer holding a slot.
      if (err instanceof GitHubError && err.status === 404) {
        jobCache.set(run.id, { jobs: [], updatedAt: run.updated_at, fetchedAt: Date.now() })
        return
      }
      if (err instanceof GitHubError && err.status === 401) throw err
      if (isRateLimitError(err)) throw err
      // Any other failure says nothing about whether the jobs still hold
      // slots. Recording them as empty would show a busy pool as clear, so
      // the last snapshot stands, the reader is told, and a poll built on a
      // snapshot it could not refresh gets no vote on the ceiling.
      contemporaneous = false
      const key = repoKey({ owner: run.repoOwner, name: run.repoName })
      if (!problems.has(key)) problems.set(key, { problem: classify(err), detail: detailOf(err) })
      const cached = jobCache.get(run.id)
      if (cached) asOf.set(run.id, cached.fetchedAt)
    }
  }

  const fetchJobsFor = async (repoRuns: readonly RunWithRepo[]): Promise<void> => {
    const now = Date.now()
    const needed = repoRuns.filter((run) => {
      const cached = jobCache.get(run.id)
      if (!cached) return true
      if (cached.updatedAt !== run.updated_at) return true
      if (now - cached.fetchedAt > MAX_JOB_STALENESS_MS) return true
      if (now - cached.fetchedAt > SAMPLE_MAX_AGE_MS) contemporaneous = false
      return false
    })
    await mapLimit(needed, JOB_CONCURRENCY, fetchJobs)
  }

  /**
   * Refetches the jobs behind any pool that reads over its ceiling from a
   * snapshot older than the sampling window.
   *
   * A reused snapshot can still list jobs that have finished since, and beside
   * newer runs that can put a pool over a ceiling it cannot exceed. So an
   * impossible reading pays for its own re-measurement: a count that was an
   * artefact of mixing moments falls back, while a genuine excess survives it
   * on fresh data and still reaches the suspect-observation banner. A pool
   * within its ceiling costs nothing extra.
   */
  const remeasureOverCap = async (): Promise<void> => {
    const all = [...byRepo.values()].flat()
    const now = Date.now()
    const suspect = new Set<number>()
    for (const bucket of buildBuckets(all, cachedJobs(all), PLANS[settings.value.plan])) {
      if (bucket.cap === null || bucket.running.length <= bucket.cap) continue
      for (const { run } of bucket.running) {
        // An older answer is shown marked; asking its repository again now
        // would only fail again.
        if (asOf.has(run.id)) continue
        const cached = jobCache.get(run.id)
        if (cached && now - cached.fetchedAt > SAMPLE_MAX_AGE_MS) suspect.add(run.id)
      }
    }
    await mapLimit(all.filter((run) => suspect.has(run.id)), JOB_CONCURRENCY, fetchJobs)
  }

  try {
    await mapLimit(repos, REPO_CONCURRENCY, async (repo) => {
      if (controller.signal.aborted || mine !== generation) return
      try {
        const [queued, running] = await Promise.all([
          listRuns(repo, 'queued', { signal: controller.signal }),
          listRuns(repo, 'in_progress', { signal: controller.signal }),
        ])
        const repoRuns = mergeRunLists(queued, running, MAX_RUNS_PER_REPO)
        await fetchJobsFor(repoRuns)
        byRepo.set(repoKey(repo), repoRuns)
        lastGood.set(repoKey(repo), { runs: repoRuns, at: Date.now() })
      } catch (err) {
        if (err instanceof GitHubError && err.status === 401) throw err
        if (isRateLimitError(err)) throw err
        const key = repoKey(repo)
        const problem = classify(err)
        problems.set(key, { problem, detail: detailOf(err) })
        const snap = lastGood.get(key)
        if (snap) {
          for (const run of snap.runs) keep.add(run.id)
          if (snapshotUsable(problem, snap.at, Date.now())) {
            byRepo.set(key, snap.runs)
            standIns.set(key, snap.at)
            for (const run of snap.runs) asOf.set(run.id, snap.at)
            contemporaneous = false
          }
        }
      } finally {
        completed++
        if (mine === generation) {
          pollProgress.value = { done: completed, total: repos.length }
          if (publishAsWeGo) publish()
        }
      }
    })

    if (controller.signal.aborted || mine !== generation) return

    await remeasureOverCap()
    if (controller.signal.aborted || mine !== generation) return

    const listed = [...byRepo.values()].flat()
    // The runs the last poll showed, which is what anything gone is looked up in.
    const previous = new Map(runs.value.map((run) => [run.id, run]))
    const removed = pruneJobCache(new Set([...listed.map((r) => r.id), ...keep])).filter((r) =>
      previous.has(r.id),
    )
    const finals = await learnFinishedRuns(
      removed.filter((r) => r.unfinished).map((r) => previous.get(r.id)!),
      controller.signal,
    )
    if (controller.signal.aborted || mine !== generation) return
    lastBilled = Math.max(1, getBilledCount() - billedBefore)

    const nowMs = Date.now()

    // How each run that left ended, from the listing already in hand: its last
    // snapshot when that was complete, or the final one just fetched.
    const requested = cancelRequested.peek()
    const ended: FinishedRun[] = []
    for (const gone of removed) {
      // A run that answered 404 has no jobs to tell anything by.
      if (gone.jobs.length === 0) continue
      const { outcome, failed } = classifyFinished(gone.unfinished ? (finals.get(gone.id) ?? null) : gone.jobs)
      ended.push({
        run: previous.get(gone.id)!,
        outcome,
        failedJobs: failed.map((j) => ({ id: j.id, name: j.name, url: j.html_url })),
        at: nowMs,
        cancelledHere: requested.has(gone.id),
        rerunAsked: false,
      })
    }
    const endedIds = new Set(removed.map((r) => r.id))
    const stillRequested = new Map(
      [...requested].filter(([id, at]) => !endedIds.has(id) && nowMs - at < CANCEL_REQUEST_TTL_MS),
    )
    const health = new Map<string, RepoProblem>()
    for (const repo of repos) {
      const key = repoKey(repo)
      const found = problems.get(key)
      if (!found) {
        failingSince.delete(key)
        continue
      }
      const since = failingSince.get(key) ?? nowMs
      failingSince.set(key, since)
      health.set(key, { ...found, since, asOf: standIns.get(key) ?? null })
    }

    publish()
    learnFromCache()
    // A poll that missed a repository is not a picture of the pools, so it is
    // left out of history, where the gap is drawn as one.
    if (isComplete(repos.length, health)) {
      recordHistory(buckets.value, nowMs, effectiveIntervalMs.value || settings.value.pollIntervalMs)
    }
    batch(() => {
      lastPoll.value = nowMs
      pollCost.value = lastBilled
      firstLoadDone.value = true
      rateLimited.value = null
      repoProblems.value = health
      fatalError.value = null
      recentlyFinished.value = addFinished(
        recentlyFinished.peek(),
        ended,
        new Set(listed.map((r) => r.id)),
        nowMs,
      )
      if (stillRequested.size !== requested.size) cancelRequested.value = stillRequested
    })
    if (contemporaneous && health.size === 0) recordObserved()
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

export interface Pacing {
  ms: number
  reason: PacingReason
}

/**
 * The delay before the next poll, and why.
 *
 * Spreads at most BUDGET_SAFETY of the remaining requests across the time left
 * in the window, so the dashboard cannot spend its way to a hard stop. The
 * configured interval is a floor: when the budget is comfortable, that is what
 * gets used, and the pacing is invisible.
 */
export function computePacing(input: PacingInput): Pacing {
  const { baseMs, remaining, resetEpochSec, billedPerPoll, retryAfterMs, nowMs } = input

  // An explicit instruction from the API wins outright.
  if (retryAfterMs > 0) {
    const ms = Math.min(MAX_RETRY_AFTER_MS, Math.max(baseMs, retryAfterMs))
    return { ms, reason: ms > baseMs ? 'retry-after' : 'floor' }
  }

  if (remaining === null) return { ms: baseMs, reason: 'floor' }

  // Waiting beyond the reset buys nothing, since the allowance refills there.
  const msToReset = Math.max(0, resetEpochSec * 1000 - nowMs)
  const ceiling = Math.max(baseMs, msToReset + RESET_MARGIN_MS)

  if (remaining <= 0) return { ms: ceiling, reason: 'refill' }

  const billed = Math.max(1, billedPerPoll)
  const secondsToReset = Math.max(60, resetEpochSec - nowMs / 1000)
  const affordablePolls = (remaining * BUDGET_SAFETY) / billed
  if (affordablePolls <= 0) return { ms: ceiling, reason: 'refill' }

  const requiredMs = (secondsToReset / affordablePolls) * 1000
  if (requiredMs <= baseMs) return { ms: baseMs, reason: 'floor' }
  if (requiredMs >= ceiling) return { ms: ceiling, reason: 'refill' }
  return { ms: requiredMs, reason: 'budget' }
}

/** The delay before the next poll. */
export function computeInterval(input: PacingInput): number {
  return computePacing(input).ms
}

function nextPacing(): Pacing {
  const limit = getRateLimit()
  return computePacing({
    baseMs: settings.value.pollIntervalMs,
    remaining: limit ? limit.remaining : null,
    resetEpochSec: limit ? limit.reset : 0,
    billedPerPoll: lastBilled,
    retryAfterMs: getRetryAfterMs(),
    nowMs: Date.now(),
  })
}

function schedule(): void {
  // Stopped pollers stay stopped. A poll superseded by a newer one leaves the
  // scheduling to that one, which is still in flight.
  if (!started || polling.peek()) return
  if (timer !== null) clearTimeout(timer)
  const { ms, reason } = nextPacing()
  batch(() => {
    effectiveIntervalMs.value = ms
    pacingReason.value = reason
    nextPollAt.value = Date.now() + ms
  })
  timer = setTimeout(() => {
    void pollOnce().finally(schedule)
  }, ms)
}

/** Why a refresh on demand would not be allowed right now, or null when it would. */
export function whyNoRefresh(nowMs = Date.now()): RefreshBlock | null {
  return refreshBlock({
    online: online.peek(),
    limited: rateLimited.peek() !== null,
    polling: polling.peek(),
    pacing: pacingReason.peek(),
    lastStartedAt,
    nowMs,
  })
}

/**
 * Polls now instead of when the timer says. Refused while the pacer is holding
 * back, so asking cannot spend more than waiting would. `force` is for a poll
 * the reader's own action needs, such as seeing a cancel take effect.
 */
export function refreshNow(options: { force?: boolean } = {}): boolean {
  if (!started) return false
  if (!options.force && whyNoRefresh() !== null) return false
  if (timer !== null) clearTimeout(timer)
  timer = null
  void pollOnce().finally(schedule)
  return true
}

/**
 * Re-arms the pending timer from the current settings, so a changed interval
 * applies now rather than after the delay chosen under the old one. A poll in
 * flight reschedules itself when it finishes.
 */
export function reschedule(): void {
  if (!started || timer === null || polling.peek()) return
  schedule()
}

export function startPolling(): void {
  stopPolling()
  started = true
  void pollOnce().finally(schedule)
}

export function stopPolling(): void {
  started = false
  if (timer !== null) clearTimeout(timer)
  timer = null
  inFlight?.abort()
  inFlight = null
  generation++
  polling.value = false
  nextPollAt.value = null
}

/**
 * Clears cached job data and everything remembered about each repository, so
 * the next poll refetches everything and trusts nothing older.
 */
export function clearJobCache(): void {
  jobCache.clear()
  lastGood.clear()
  failingSince.clear()
  recentSamples.length = 0
  lastBilled = 1
  lastStartedAt = null
}
