import type { BucketForecast, Insight } from '../model/forecast'
import type { ClassBucket } from '../model/queue'
import { RUNNER_CLASS_LABEL } from '../model/runnerClass'
import { duration, relative, shortClock } from './format'
import { endNote, isDue } from './verdict'

interface Props {
  bucket: ClassBucket
  forecast: BucketForecast
  insight: Insight | null
  nowMs: number
}

/** A cancel is worth offering in the tile only when it moves the queue by this much. */
const MIN_SAVING_MS = 60_000

/**
 * The two numbers a reader opens the page for: when the next slot frees and
 * when the queue clears. Shown for the pool under most pressure only. Every
 * figure is an estimate and says so with "~"; one resting on a job already
 * past its usual time is a bound, said as "or later", and one resting on a
 * guessed duration says that too. The notes are short enough for a phone.
 */
export function SummaryTiles({ bucket, forecast, insight, nowMs }: Props) {
  const used = bucket.running.length
  const cap = bucket.cap
  const free = cap !== null && used < cap
  const pool = RUNNER_CLASS_LABEL[bucket.cls]

  let next: string
  let nextNote: string
  if (free) {
    next = 'free now'
    nextNote = `${cap - used} of ${cap} ${pool} slots idle`
  } else if (forecast.nextSlotAt === null) {
    // Not a question mark: say what is missing and what will fill it in.
    next = 'learning'
    nextNote = 'appears as jobs finish'
  } else {
    const job = forecast.nextToFinish
    const f = job ? forecast.jobs.get(job.job.id) : undefined
    // The same words the timeline puts on the job's row, so the two agree.
    const note = f ? endNote(f.usualEnd, f.guessed, nowMs, shortClock, duration) : null
    if (job && note !== null && isDue(note)) {
      next = 'any time'
      nextNote = `${job.job.name} ${note}`
    } else {
      next = relative(forecast.nextSlotAt, nowMs)
      nextNote = job ? `${job.job.name} finishing${forecast.nextSlotBasis === 'guessed' ? ' (guess)' : ''}` : `${pool} slot`
    }
  }

  const clears = forecast.queueClearsAt
  const queued = bucket.queued.length
  const saving =
    clears !== null && insight && insight.queueClearsAtIfCancelled !== null && insight.basis !== 'floor'
      ? clears - insight.queueClearsAtIfCancelled
      : 0
  const clearsText = queued === 0 ? 'no queue' : clears === null ? 'learning' : `~${shortClock(clears)}`
  const clearsNote =
    queued === 0
      ? `${pool} queue is empty`
      : clears === null
        ? 'not every job seen yet'
        : insight && saving >= MIN_SAVING_MS
          ? `cancel #${insight.run.run_number}: ${duration(saving / 1000)} sooner`
          : forecast.queueClearsBasis === 'floor'
            ? `or later · ${queued} queued`
            : forecast.queueClearsBasis === 'guessed'
              ? `${queued} queued · a guess`
              : `${queued} queued ${pool} job${queued === 1 ? '' : 's'}`

  return (
    <div class="tiles">
      <div class="tile">
        <div class="tile-label">Next slot</div>
        <div class="tile-value">{next}</div>
        <div class="tile-note">{nextNote}</div>
      </div>
      <div class="tile">
        <div class="tile-label">Queue clears</div>
        <div class="tile-value">{clearsText}</div>
        <div class="tile-note">{clearsNote}</div>
      </div>
    </div>
  )
}
