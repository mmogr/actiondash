import { groupByRun, type ClassBucket } from '../model/queue'
import { RUNNER_CLASS_LABEL } from '../model/runnerClass'
import { gaugeCells } from './lanes'
import { seriesClass } from './palette'

interface Props {
  bucket: ClassBucket
  cap: number
}

/**
 * How full a pool is and whether anyone is waiting, in one strip: a cell per
 * slot, filled in the colour of the repository holding it, then an amber
 * outlined cell per waiting job after a gap. A pool with room and nobody
 * waiting shows empty cells and no amber at all; a full pool with a line
 * behind it looks like one.
 *
 * A pool with more slots than cells can show (Enterprise's 500) gets a plain
 * proportional bar, with the queue left to the figures beside it.
 */
export function PoolGauge({ bucket, cap }: Props) {
  const used = bucket.running.length
  const queued = bucket.queued.length
  const pool = RUNNER_CLASS_LABEL[bucket.cls]
  const label =
    `${used} of ${cap} ${pool} slots in use, ` +
    (queued === 0 ? 'nothing waiting' : `${queued} ${queued === 1 ? 'job' : 'jobs'} waiting`)
  const cells = gaugeCells(used, cap, queued)

  if (cells === null) {
    const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0
    return (
      <div class="meter" role="img" aria-label={label}>
        <div class="meter-fill" style={{ width: `${pct}%` }} />
      </div>
    )
  }

  // Cells take the colour of the run's repository, run by run, oldest first,
  // the order the list below uses.
  const held = groupByRun(bucket.running).flatMap((g) => g.jobs.map(() => seriesClass(g.repo)))

  return (
    <div class={`gauge${queued > 0 ? ' has-queue' : ''}`} role="img" aria-label={label}>
      {Array.from({ length: cells.slots }, (_, i) => (
        <span key={`s${i}`} class={i < cells.used ? `gauge-cell used ${held[i] ?? 'series-0'}` : 'gauge-cell free'} />
      ))}
      {cells.queued > 0 && <span class="gauge-gap" />}
      {Array.from({ length: cells.queued }, (_, i) => (
        <span key={`q${i}`} class="gauge-cell queued" />
      ))}
      {cells.more > 0 && <span class="gauge-more">+{cells.more}</span>}
    </div>
  )
}
