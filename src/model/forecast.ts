import type { RepoRef, RunWithRepo } from '../github/types'
import {
  durationKey,
  fallbackSeconds,
  typicalSeconds,
  type DurationMap,
} from './durations'
import { isCancelRequested } from './finished'
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

/**
 * A running job is never forecast to end in the past; give it at least this
 * long. Only the queue forecast uses this floor. It is a placeholder, not an
 * estimate, so anything resting on it has the basis 'floor' and is never drawn
 * as an end.
 */
const MIN_REMAINING_MS = 60_000

/**
 * What a forecast time rests on, worst first. A learned time comes from this
 * job's own successful runs. A guessed one borrows the durations of other
 * jobs in the pool. A floor rests on a job already past its usual time, whose
 * end is only "not before now": the real time is that one or later.
 */
export type Basis = 'floor' | 'guessed' | 'learned'

const BASIS_RANK: Record<Basis, number> = { floor: 2, guessed: 1, learned: 0 }

/** The weaker of two bases: a chain of estimates is as good as its worst link. */
export function worstBasis(a: Basis, b: Basis): Basis {
  return BASIS_RANK[a] >= BASIS_RANK[b] ? a : b
}

/**
 * A job counts as past its usual time once it is this far over: a quarter of
 * its usual time, and never less than a minute, so ordinary jitter is not
 * flagged.
 */
const OVERDUE_SHARE = 0.25
const OVERDUE_MIN_MS = 60_000

export interface JobForecast {
  entry: DashJob
  /** Zero-based slot the job holds or is expected to take. */
  lane: number
  /** Epoch ms the job started or is expected to start. */
  start: number
  /** Epoch ms the job is expected to finish, or null when nothing is known. */
  end: number | null
  /**
   * For a running job, when its usual time runs out: its start plus its usual
   * duration, even when that has passed. Unlike `end`, never pushed into the
   * future, so a drawing can show a job running past it. Null when unknown.
   */
  usualEnd: number | null
  /** Usual duration in seconds, or null when nothing is known. */
  typical: number | null
  /** True when the duration came from other jobs of the class rather than this one. */
  guessed: boolean
  /** Successful runs of this job the estimate is drawn from; 0 when guessed. */
  samples: number
  /**
   * True when a running job is well past its own usual time (see
   * OVERDUE_SHARE). Never raised from a guess: a guess borrowed from other
   * jobs says nothing about whether this one is slow.
   */
  overdue: boolean
  /**
   * What the time this job is shown with rests on: its end while running, or
   * its start while queued, which is as good as whatever frees the slot.
   */
  basis: Basis
}

export interface RunForecast {
  firstStart: number | null
  allDone: number | null
  /** The weakest basis of any time the run's jobs are given. */
  basis: Basis
}

export interface BucketForecast {
  lanes: number
  /** By job id. */
  jobs: Map<number, JobForecast>
  /** By run id. */
  runs: Map<number, RunForecast>
  /** When the first slot frees, or null when no running job's end can be estimated. */
  nextSlotAt: number | null
  /** What nextSlotAt rests on. */
  nextSlotBasis: Basis
  /** The running job that frees that slot, when there is one. */
  nextToFinish: DashJob | null
  /** When the last queued job is expected to finish, or null when any is unknown. */
  queueClearsAt: number | null
  /** The weakest basis anywhere in the queue, which is what queueClearsAt rests on. */
  queueClearsBasis: Basis
}

interface Lane {
  freeAt: number | null
  /** What freeAt rests on. */
  basis: Basis
}

function usual(
  entry: DashJob,
  durations: DurationMap,
): { typical: number | null; guessed: boolean; samples: number } {
  const key = durationKey(entry.repo, entry.job.name)
  const own = typicalSeconds(durations, key)
  if (own !== undefined) return { typical: own, guessed: false, samples: durations[key]?.secs.length ?? 0 }
  const fallback = fallbackSeconds(durations, entry.cls)
  return { typical: fallback ?? null, guessed: true, samples: 0 }
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
      basis: worstBasis(found.basis, part.basis),
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
    const found = usual(entry, durations)
    const { guessed, samples } = found
    const elapsedMs = entry.since > 0 ? nowMs - entry.since : 0
    // A guess the job has already outlived says nothing more about it, and a
    // job with no start time cannot be timed at all.
    const outlived = guessed && found.typical !== null && elapsedMs > found.typical * 1000
    const typical = outlived ? null : found.typical
    const usualEnd = typical === null || entry.since <= 0 ? null : entry.since + typical * 1000
    // Past its usual time the end is unknown; the floor keeps the queue
    // forecast going, and the basis says it is only a floor.
    const end = usualEnd === null ? null : Math.max(usualEnd, nowMs + MIN_REMAINING_MS)
    const basis: Basis = usualEnd !== null && usualEnd < nowMs ? 'floor' : guessed ? 'guessed' : 'learned'
    const overdue =
      !guessed &&
      typical !== null &&
      entry.since > 0 &&
      elapsedMs > typical * 1000 + Math.max(OVERDUE_MIN_MS, typical * 1000 * OVERDUE_SHARE)
    return { entry, end, usualEnd, typical, guessed, samples, overdue, basis }
  })
  runningForecasts.sort((a, b) => (a.end ?? Infinity) - (b.end ?? Infinity))

  const lanes: Lane[] = []
  runningForecasts.forEach((f, i) => {
    lanes.push({ freeAt: f.end, basis: f.basis })
    jobs.set(f.entry.job.id, {
      entry: f.entry,
      lane: i,
      start: f.entry.since,
      end: f.end,
      usualEnd: f.usualEnd,
      typical: f.typical,
      guessed: f.guessed,
      samples: f.samples,
      overdue: f.overdue,
      basis: f.basis,
    })
  })
  // Idle slots free up right now.
  while (lanes.length < laneCount) lanes.push({ freeAt: nowMs, basis: 'learned' })

  const nextToFinish = runningForecasts.find((f) => f.end !== null)?.entry ?? null
  let firstFree: Lane | null = null
  for (const lane of lanes) {
    if (lane.freeAt === null) continue
    if (firstFree === null || lane.freeAt < firstFree.freeAt!) firstFree = lane
  }
  const nextSlotAt = lanes.length > running.length ? nowMs : (firstFree?.freeAt ?? null)
  const nextSlotBasis: Basis = lanes.length > running.length ? 'learned' : (firstFree?.basis ?? 'learned')

  // Queued jobs, in queue order, each taking the slot that frees first.
  let queueClearsAt: number | null = queued.length === 0 ? null : 0
  let queueClearsBasis: Basis = 'learned'
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
        usualEnd: null,
        typical,
        guessed,
        samples,
        overdue: false,
        basis: 'learned',
      })
      queueClearsAt = null
      continue
    }
    const lane = lanes[laneIndex]!
    const start = Math.max(lane.freeAt!, nowMs)
    const end = typical === null ? null : start + typical * 1000
    // The start is as good as whatever freed the slot; the slot's next
    // release is also only as good as this job's own duration.
    const basis = lane.basis
    lane.freeAt = end
    lane.basis = worstBasis(basis, guessed ? 'guessed' : 'learned')
    jobs.set(entry.job.id, {
      entry,
      lane: laneIndex,
      start,
      end,
      usualEnd: end,
      typical,
      guessed,
      samples,
      overdue: false,
      basis,
    })
    if (queueClearsAt !== null) queueClearsAt = end === null ? null : Math.max(queueClearsAt, end)
    queueClearsBasis = worstBasis(queueClearsBasis, lane.basis)
  }

  const runs = new Map<number, RunForecast>()
  for (const f of jobs.values()) {
    const id = f.entry.run.id
    const current = runs.get(id) ?? { firstStart: null, allDone: null, basis: 'learned' as Basis }
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
    // A queued job's own duration is not in its start's basis, but its end
    // rests on it, and so does the run's.
    const own: Basis = f.guessed ? 'guessed' : 'learned'
    runs.set(id, { firstStart, allDone, basis: worstBasis(current.basis, worstBasis(f.basis, own)) })
  }

  return {
    lanes: lanes.length,
    jobs,
    runs,
    nextSlotAt,
    nextSlotBasis,
    nextToFinish,
    queueClearsAt,
    queueClearsBasis: queueClearsAt === null ? 'learned' : queueClearsBasis,
  }
}

export interface Insight {
  /** The superseded run whose cancellation helps most. */
  run: RunWithRepo
  repo: RepoRef
  /** The newer run that made it pointless. */
  supersededBy: RunWithRepo
  /** Slots of this pool the run holds now; 0 when it is only waiting. */
  holding: number
  /** The first queued job of a run that is not itself superseded. */
  beneficiary: DashJob
  /** Epoch ms the beneficiary starts with and without the cancellation. */
  startsAt: number
  startsAtIfCancelled: number
  /** When the queue clears if the run is cancelled, or null when unknown. */
  queueClearsAtIfCancelled: number | null
  /** What the saving rests on: a floor means the figure is a bound, not an amount. */
  basis: Basis
}

/** Worth mentioning only when a cancellation moves something by at least this much. */
const MIN_SAVING_MS = 60_000

/**
 * The one superseded run whose cancellation would most help the first
 * legitimate queued job, or null when none would. Every superseded run is
 * worth cancelling; this names the one that is worth cancelling first.
 *
 * A run whose cancel has been asked for is not named again: GitHub has yet to
 * act on it, and offering it a second time would invite a second request.
 */
export function insightFor(
  bucket: ClassBucket,
  durations: DurationMap,
  nowMs: number,
  requested: ReadonlyMap<number, number> = new Map(),
): Insight | null {
  const stale = new Map<number, DashJob>()
  for (const j of [...bucket.running, ...bucket.queued]) {
    if (j.supersededBy !== null && !isCancelRequested(requested, j.run.id, nowMs)) stale.set(j.run.id, j)
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
      holding: bucket.running.filter((j) => j.run.id === runId).length,
      beneficiary,
      startsAt: baseline.start,
      startsAtIfCancelled: moved.start,
      queueClearsAtIfCancelled: without.queueClearsAt,
      basis: worstBasis(baseline.basis, moved.basis),
    }
  }
  return best
}
