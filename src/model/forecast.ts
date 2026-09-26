import type { RepoRef, RunWithRepo } from '../github/types'
import {
  durationKey,
  fallbackSeconds,
  rangeSeconds,
  typicalSeconds,
  type DurationMap,
} from './durations'
import type { ClassBucket, DashJob } from './queue'

/**
 * When each running job should finish and when each queued job should start,
 * from the learned durations and the pool's ceiling.
 *
 * The model is the simple one GitHub's dispatcher approximates: a fixed number
 * of slots, and the oldest waiting job takes whichever slot frees first. Every
 * figure is an estimate and is labelled as one, but it turns "7 queued" into
 * "yours starts at about 22:31", which is the question the reader has.
 */

/** A running job is never forecast to end in the past; give it at least this long. */
const MIN_REMAINING_MS = 60_000

export interface JobForecast {
  entry: DashJob
  /** Zero-based slot the job holds or is expected to take. */
  lane: number
  /** Epoch ms the job started or is expected to start. */
  start: number
  /** Epoch ms the job is expected to finish, or null when nothing is known. */
  end: number | null
  /** Usual duration in seconds, or null when nothing is known. */
  typical: number | null
  /** True when the duration came from other jobs of the class rather than this one. */
  guessed: boolean
  /** Successful runs of this job the estimate is drawn from; 0 when guessed. */
  samples: number
  /** True when a running job has already taken longer than any kept run of it. */
  overdue: boolean
}

export interface RunForecast {
  firstStart: number | null
  allDone: number | null
}

export interface BucketForecast {
  lanes: number
  /** By job id. */
  jobs: Map<number, JobForecast>
  /** By run id. */
  runs: Map<number, RunForecast>
  /** When the first slot frees, or null when no running job's end can be estimated. */
  nextSlotAt: number | null
  /** The running job that frees that slot, when there is one. */
  nextToFinish: DashJob | null
  /** When the last queued job is expected to finish, or null when any is unknown. */
  queueClearsAt: number | null
}

interface Lane {
  freeAt: number | null
}

function usual(
  entry: DashJob,
  durations: DurationMap,
): { typical: number | null; guessed: boolean; samples: number; max: number | null } {
  const key = durationKey(entry.repo, entry.job.name)
  const own = typicalSeconds(durations, key)
  if (own !== undefined) {
    const range = rangeSeconds(durations, key)
    const samples = durations[key]?.secs.length ?? 0
    return { typical: own, guessed: false, samples, max: range ? range[1] : own }
  }
  const fallback = fallbackSeconds(durations, entry.cls)
  return fallback === undefined
    ? { typical: null, guessed: true, samples: 0, max: null }
    : { typical: fallback, guessed: true, samples: 0, max: fallback }
}

/**
 * One run's outlook across every pool its jobs use. A run that builds on
 * macOS and tests on Linux is done when both are, and unknown if either is.
 */
export function runOutlook(runId: number, forecasts: Iterable<BucketForecast>): RunForecast | null {
  let found: RunForecast | null = null
  for (const forecast of forecasts) {
    const part = forecast.runs.get(runId)
    if (!part) continue
    if (found === null) {
      found = { ...part }
      continue
    }
    found = {
      firstStart:
        found.firstStart === null
          ? part.firstStart
          : part.firstStart === null
            ? found.firstStart
            : Math.min(found.firstStart, part.firstStart),
      allDone: found.allDone === null || part.allDone === null ? null : Math.max(found.allDone, part.allDone),
    }
  }
  return found
}

/**
 * Forecasts one pool. Runs in `exclude` are left out, which is how the
 * insight asks "what if that one were cancelled".
 */
export function forecastBucket(
  bucket: ClassBucket,
  durations: DurationMap,
  nowMs: number,
  exclude: ReadonlySet<number> = new Set(),
): BucketForecast {
  const running = bucket.running.filter((j) => !exclude.has(j.run.id))
  const queued = bucket.queued.filter((j) => !exclude.has(j.run.id))
  const laneCount = Math.max(bucket.cap ?? 0, running.length, bucket.cap === null ? 1 : 0)
  const jobs = new Map<number, JobForecast>()

  // Running jobs, soonest to finish first, so lane 1 is the one that frees next.
  const runningForecasts = running.map((entry) => {
    const { typical, guessed, samples, max } = usual(entry, durations)
    const elapsedMs = entry.since > 0 ? nowMs - entry.since : 0
    const end =
      typical === null
        ? null
        : Math.max(entry.since + typical * 1000, nowMs + MIN_REMAINING_MS)
    const overdue = max !== null && entry.since > 0 && elapsedMs > max * 1000
    return { entry, end, typical, guessed, samples, overdue }
  })
  runningForecasts.sort((a, b) => (a.end ?? Infinity) - (b.end ?? Infinity))

  const lanes: Lane[] = []
  runningForecasts.forEach((f, i) => {
    lanes.push({ freeAt: f.end })
    jobs.set(f.entry.job.id, {
      entry: f.entry,
      lane: i,
      start: f.entry.since,
      end: f.end,
      typical: f.typical,
      guessed: f.guessed,
      samples: f.samples,
      overdue: f.overdue,
    })
  })
  // Idle slots free up right now.
  while (lanes.length < laneCount) lanes.push({ freeAt: nowMs })

  const nextToFinish = runningForecasts.find((f) => f.end !== null)?.entry ?? null
  const nextSlotAt =
    lanes.length > running.length
      ? nowMs
      : lanes.reduce<number | null>(
          (best, lane) =>
            lane.freeAt === null ? best : best === null ? lane.freeAt : Math.min(best, lane.freeAt),
          null,
        )

  // Queued jobs, in queue order, each taking the slot that frees first.
  let queueClearsAt: number | null = queued.length === 0 ? null : 0
  for (const entry of queued) {
    let laneIndex = -1
    for (let i = 0; i < lanes.length; i++) {
      const lane = lanes[i]!
      if (lane.freeAt === null) continue
      if (laneIndex === -1 || lane.freeAt < lanes[laneIndex]!.freeAt!) laneIndex = i
    }
    const { typical, guessed, samples } = usual(entry, durations)
    if (laneIndex === -1) {
      // Every slot's release time is unknown, so nothing behind them is either.
      jobs.set(entry.job.id, {
        entry,
        lane: 0,
        start: 0,
        end: null,
        typical,
        guessed,
        samples,
        overdue: false,
      })
      queueClearsAt = null
      continue
    }
    const lane = lanes[laneIndex]!
    const start = Math.max(lane.freeAt!, nowMs)
    const end = typical === null ? null : start + typical * 1000
    lane.freeAt = end
    jobs.set(entry.job.id, { entry, lane: laneIndex, start, end, typical, guessed, samples, overdue: false })
    if (queueClearsAt !== null) queueClearsAt = end === null ? null : Math.max(queueClearsAt, end)
  }

  const runs = new Map<number, RunForecast>()
  for (const f of jobs.values()) {
    const id = f.entry.run.id
    const current = runs.get(id) ?? { firstStart: null, allDone: null }
    const start = f.start > 0 ? f.start : null
    const firstStart =
      current.firstStart === null ? start : start === null ? current.firstStart : Math.min(current.firstStart, start)
    // A run is done when its last job is, and unknown if any job is.
    const seen = runs.has(id)
    const allDone = !seen
      ? f.end
      : current.allDone === null || f.end === null
        ? null
        : Math.max(current.allDone, f.end)
    runs.set(id, { firstStart, allDone })
  }

  return { lanes: lanes.length, jobs, runs, nextSlotAt, nextToFinish, queueClearsAt }
}

export interface Insight {
  /** The superseded run whose cancellation helps most. */
  run: RunWithRepo
  repo: RepoRef
  /** The newer run that made it pointless. */
  supersededBy: RunWithRepo
  /** The first queued job of a run that is not itself superseded. */
  beneficiary: DashJob
  /** Epoch ms the beneficiary starts with and without the cancellation. */
  startsAt: number
  startsAtIfCancelled: number
  /** When the queue clears if the run is cancelled, or null when unknown. */
  queueClearsAtIfCancelled: number | null
}

/** Worth mentioning only when a cancellation moves something by at least this much. */
const MIN_SAVING_MS = 60_000

/**
 * The one superseded run whose cancellation would most help the first
 * legitimate queued job, or null when none would. Every superseded run is
 * worth cancelling; this names the one that is worth cancelling first.
 */
export function insightFor(
  bucket: ClassBucket,
  durations: DurationMap,
  nowMs: number,
): Insight | null {
  const stale = new Map<number, DashJob>()
  for (const j of [...bucket.running, ...bucket.queued]) {
    if (j.supersededBy !== null) stale.set(j.run.id, j)
  }
  if (stale.size === 0) return null
  const beneficiary = bucket.queued.find((j) => j.supersededBy === null)
  if (!beneficiary) return null

  const baseline = forecastBucket(bucket, durations, nowMs).jobs.get(beneficiary.job.id)
  if (!baseline || baseline.end === null && baseline.start === 0) return null

  let best: Insight | null = null
  for (const [runId, sample] of stale) {
    const without = forecastBucket(bucket, durations, nowMs, new Set([runId]))
    const moved = without.jobs.get(beneficiary.job.id)
    if (!moved || moved.start === 0) continue
    const saving = baseline.start - moved.start
    if (saving < MIN_SAVING_MS) continue
    if (best && baseline.start - best.startsAtIfCancelled >= saving) continue
    best = {
      run: sample.run,
      repo: sample.repo,
      supersededBy: sample.supersededBy!,
      beneficiary,
      startsAt: baseline.start,
      startsAtIfCancelled: moved.start,
      queueClearsAtIfCancelled: without.queueClearsAt,
    }
  }
  return best
}
