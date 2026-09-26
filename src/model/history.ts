import { repoKey, type RunnerClass } from '../github/types'
import type { ClassBucket } from './queue'
import { RUNNER_CLASS_ORDER } from './runnerClass'

/**
 * What the pools looked like over time, as the dashboard saw them. Built from
 * the same polls that draw the page and kept in local storage, so it records
 * only what this browser watched: a closed tab is a gap, and a gap is shown
 * as one rather than smoothed over.
 *
 * Everything here is pure. Persistence lives in state/history.ts.
 */

/** Consecutive polls that read the same collapse into one sample; this many survive. */
export const MAX_SAMPLES = 2_000
/** Days of repository slot time kept. */
export const KEEP_DAYS = 7
/** A silence longer than this many polling intervals is a gap, never a plateau. */
const GAP_INTERVALS = 3
/** And never shorter than this, so a slow poll is not mistaken for a closed tab. */
const GAP_MIN_MS = 2 * 60_000

export type Counts = Partial<Record<RunnerClass, number>>

export interface Sample {
  /** Epoch ms of the first poll that read this way. */
  t: number
  /** Epoch ms of the last poll that still read this way. */
  until: number
  inUse: Counts
  queued: Counts
  /** True when the next sample came after a silence: nothing is known in between. */
  gap?: true
}

/** Seconds of slot time per class, per repository, per local day. */
export type DayShare = Record<string, Record<string, Counts>>

export interface HistoryState {
  samples: Sample[]
  days: DayShare
}

export const EMPTY_HISTORY: HistoryState = { samples: [], days: {} }

function countsOf(buckets: readonly ClassBucket[]): { inUse: Counts; queued: Counts } {
  const inUse: Counts = {}
  const queued: Counts = {}
  for (const b of buckets) {
    if (b.running.length > 0) inUse[b.cls] = b.running.length
    if (b.queued.length > 0) queued[b.cls] = b.queued.length
  }
  return { inUse, queued }
}

function sameCounts(a: Counts, b: Counts): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<RunnerClass>
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false
  return true
}

/** Local calendar day, for the per-day share. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * Adds one poll's reading. Slot time is credited to the repositories that
 * were running during the interval since the previous poll, so a job that
 * held a slot for ten minutes across forty polls is credited ten minutes.
 */
export function record(
  state: HistoryState,
  buckets: readonly ClassBucket[],
  nowMs: number,
  intervalMs: number,
): HistoryState {
  const { inUse, queued } = countsOf(buckets)
  const samples = [...state.samples]
  const last = samples[samples.length - 1]
  const gapAfter = Math.max(GAP_MIN_MS, GAP_INTERVALS * intervalMs)
  let days = state.days

  if (last && nowMs - last.until > gapAfter) {
    samples[samples.length - 1] = { ...last, gap: true }
  } else if (last && nowMs > last.until) {
    // Credit the interval just elapsed to whoever was running at its start.
    // The previous sample only holds counts, so the running set comes from
    // the buckets of this poll, which for a short interval is the same set.
    days = credit(days, buckets, nowMs, (nowMs - last.until) / 1000)
  }

  const current = samples[samples.length - 1]
  if (current && !current.gap && sameCounts(current.inUse, inUse) && sameCounts(current.queued, queued)) {
    samples[samples.length - 1] = { ...current, until: nowMs }
  } else {
    samples.push({ t: nowMs, until: nowMs, inUse, queued })
  }

  return prune({ samples, days }, nowMs)
}

function credit(days: DayShare, buckets: readonly ClassBucket[], nowMs: number, seconds: number): DayShare {
  if (seconds <= 0) return days
  const day = dayKey(nowMs)
  const today: Record<string, Counts> = { ...(days[day] ?? {}) }
  for (const b of buckets) {
    for (const job of b.running) {
      const key = repoKey(job.repo)
      const counts: Counts = { ...(today[key] ?? {}) }
      counts[b.cls] = (counts[b.cls] ?? 0) + seconds
      today[key] = counts
    }
  }
  return { ...days, [day]: today }
}

function prune(state: HistoryState, nowMs: number): HistoryState {
  const oldest = nowMs - KEEP_DAYS * 86_400_000
  let samples = state.samples.filter((s) => s.until >= oldest)
  if (samples.length > MAX_SAMPLES) samples = samples.slice(samples.length - MAX_SAMPLES)

  const keepFrom = dayKey(oldest)
  const days: DayShare = {}
  for (const [day, share] of Object.entries(state.days)) {
    if (day >= keepFrom) days[day] = share
  }
  return { samples, days }
}

/** Samples overlapping the window, clipped to it. */
export function slice(state: HistoryState, fromMs: number, toMs: number): Sample[] {
  const out: Sample[] = []
  for (const s of state.samples) {
    if (s.until < fromMs || s.t > toMs) continue
    out.push({ ...s, t: Math.max(s.t, fromMs), until: Math.min(s.until, toMs) })
  }
  return out
}

/** The silences inside a run of samples, as [from, to] pairs. */
export function gaps(samples: readonly Sample[]): [number, number][] {
  const out: [number, number][] = []
  samples.forEach((s, i) => {
    const next = samples[i + 1]
    if (s.gap && next) out.push([s.until, next.t])
  })
  return out
}

/** Milliseconds during which the class read at or over its ceiling. */
export function atCapacityMs(samples: readonly Sample[], cls: RunnerClass, cap: number): number {
  let total = 0
  for (const s of samples) if ((s.inUse[cls] ?? 0) >= cap) total += s.until - s.t
  return total
}

/** Repositories by slot seconds on a day for one class, largest first. */
export function repoShare(
  state: HistoryState,
  day: string,
  cls: RunnerClass,
): { repo: string; seconds: number }[] {
  const share = state.days[day] ?? {}
  return Object.entries(share)
    .map(([repo, counts]) => ({ repo, seconds: counts[cls] ?? 0 }))
    .filter((r) => r.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds)
}

function isCounts(v: unknown): v is Counts {
  return (
    typeof v === 'object' &&
    v !== null &&
    Object.values(v as Record<string, unknown>).every((n) => typeof n === 'number' && n >= 0)
  )
}

/** Restores a state from storage, dropping anything malformed. */
export function sanitiseHistory(raw: unknown): HistoryState {
  if (typeof raw !== 'object' || raw === null) return EMPTY_HISTORY
  const r = raw as Partial<HistoryState>
  const samples: Sample[] = []
  if (Array.isArray(r.samples)) {
    for (const s of r.samples as Partial<Sample>[]) {
      if (typeof s?.t !== 'number' || typeof s.until !== 'number' || s.until < s.t) continue
      if (!isCounts(s.inUse) || !isCounts(s.queued)) continue
      samples.push({ t: s.t, until: s.until, inUse: s.inUse, queued: s.queued, ...(s.gap ? { gap: true } : {}) })
    }
  }
  const days: DayShare = {}
  if (typeof r.days === 'object' && r.days !== null) {
    for (const [day, share] of Object.entries(r.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof share !== 'object' || share === null) continue
      const clean: Record<string, Counts> = {}
      for (const [repo, counts] of Object.entries(share)) if (isCounts(counts)) clean[repo] = counts
      days[day] = clean
    }
  }
  return { samples: samples.slice(-MAX_SAMPLES), days }
}

/**
 * The pools anything was ever recorded in, in the dashboard's usual order.
 * Trends offers a choice only between these, so it never draws an empty chart.
 */
export function recordedPools(state: HistoryState): RunnerClass[] {
  const seen = new Set<RunnerClass>()
  for (const s of state.samples) {
    for (const [cls, n] of Object.entries(s.inUse)) if (n) seen.add(cls as RunnerClass)
    for (const [cls, n] of Object.entries(s.queued)) if (n) seen.add(cls as RunnerClass)
  }
  return RUNNER_CLASS_ORDER.filter((cls) => seen.has(cls))
}
