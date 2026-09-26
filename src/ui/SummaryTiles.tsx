import type { BucketForecast, Insight } from '../model/forecast'
import type { ClassBucket } from '../model/queue'
import { RUNNER_CLASS_LABEL } from '../model/runnerClass'
import { relative, shortClock } from './format'

interface Props {
  bucket: ClassBucket
  forecast: BucketForecast
  insight: Insight | null
  nowMs: number
}

/**
 * The two numbers a reader opens the page for: when the next slot frees and
 * when the queue clears. Shown for the scarce pool only.
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
    nextNote = 'estimates appear as jobs finish'
  } else {
    next = relative(forecast.nextSlotAt, nowMs)
    const job = forecast.nextToFinish
    nextNote = job ? `${job.job.name} finishing` : `${pool} slot`
  }

  const clears = forecast.queueClearsAt
  const clearsText =
    bucket.queued.length === 0 ? 'nothing waiting' : clears === null ? 'learning' : shortClock(clears)
  const clearsNote =
    bucket.queued.length === 0
      ? `${pool} queue is empty`
      : clears === null
        ? 'some jobs not yet seen to finish'
        : insight && insight.queueClearsAtIfCancelled !== null
          ? `${shortClock(insight.queueClearsAtIfCancelled)} if you cancel #${insight.run.run_number}`
          : `${bucket.queued.length} queued ${pool} job${bucket.queued.length === 1 ? '' : 's'}`

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
