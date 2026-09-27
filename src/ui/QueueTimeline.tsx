import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { BucketForecast, JobForecast } from '../model/forecast'
import { groupByRun, type ClassBucket, type DashJob } from '../model/queue'
import { isMine } from '../model/mine'
import { RUNNER_CLASS_LABEL } from '../model/runnerClass'
import { seriesClass } from './palette'
import { age, duration, hedge, shortClock, tickClock } from './format'
import { endNote } from './verdict'
import {
  clockTicks,
  fitCaption,
  foldQueue,
  positionsText,
  queueSegments,
  tickStep,
  timeWindow,
  type CaptionParts,
  type QueueSegment,
} from './lanes'

/**
 * A busy pool over time, in two parts read top to bottom.
 *
 * In use: one row per job holding a slot, oldest first. The part already run
 * is solid; the part still expected is pale and ends at the job's usual time.
 * A job past its usual time, or with none learned, has no end drawn at all,
 * only a fading edge, because its end is not known.
 *
 * Waiting: the queue, in line order, one row per stretch of one run's jobs,
 * numbered by place in line. An amber line is the wait: solid for the time
 * already waited, dashed for the wait still expected. A dashed box is when
 * the run's jobs are expected to run. Rows are never dropped: a long queue
 * folds into rows that say how many they hold, and the reader's own run is
 * always shown where it stands.
 *
 * Every row is captioned in words above its bar, so nothing depends on
 * colour or on a tooltip a phone cannot reach.
 */

const FALLBACK_W = 360
const MAX_W = 1200
/** Below this width fewer queue rows are shown before the tail folds. */
const NARROW_W = 480
/** Width of one character of the 11px caption. */
const CHAR_W = 6.7
const HEAD_H = 24
const CAPTION_H = 15
const BAR_H = 12
const ROW_GAP = 9
const PITCH = CAPTION_H + BAR_H + ROW_GAP
const AXIS_H = 20
/** The fading edge drawn in place of an end that is not known. */
const TAIL_STEP = 6
/** Room kept clear of other tick labels around "now 10:05". */
const NOW_CLEAR_PX = 52
const MAX_RUNNING_ROWS = 8
const MAX_QUEUE_ROWS = 8
const MAX_QUEUE_ROWS_NARROW = 6
/** Within this of now, a start is said as "now", as relative() also has it. */
const NOW_WINDOW_MS = 45_000

interface Props {
  bucket: ClassBucket
  forecast: BucketForecast
  nowMs: number
  login: string | null
}

/** The element's width in pixels, kept current as it resizes. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(FALLBACK_W)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const w = Math.round(el.clientWidth)
      if (w > 0) setWidth(Math.min(MAX_W, w))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

interface RunningRow {
  key: string
  series: string
  stale: boolean
  since: number
  /** When the usual time runs out; null when unknown. */
  usualEnd: number | null
  guessed: boolean
  caption: CaptionParts
  title: string
}

interface QueueRow {
  key: string
  series: string
  stale: boolean
  mine: boolean
  /** Characters of the caption's label that are the place in line. */
  prefix: number
  since: number
  start: number | null
  end: number | null
  caption: CaptionParts
  title: string
}

function who(j: DashJob): string {
  return `${j.repo.name} #${j.run.run_number}`
}

/** The words after a running job's name, shared with the tiles so the two agree. */
const note = (usualEnd: number | null, guessed: boolean, nowMs: number) =>
  endNote(usualEnd, guessed, nowMs, shortClock, duration)

function runningRows(bucket: ClassBucket, forecast: BucketForecast, nowMs: number, login: string | null): RunningRow[] {
  const groups = groupByRun(bucket.running)
  // Rows keep the list's order, run by run, so they do not reshuffle between
  // polls, and every row carries its run's tags: a striped bar alone says nothing.
  const one = (entry: DashJob): RunningRow => {
    const f = forecast.jobs.get(entry.job.id)
    const usualEnd = f?.usualEnd ?? null
    const guessed = f?.guessed ?? false
    const stale = entry.supersededBy !== null
    return {
      key: `j${entry.job.id}`,
      series: seriesClass(entry.repo),
      stale,
      since: entry.since,
      usualEnd,
      guessed,
      caption: {
        label: `${who(entry)} · ${entry.job.name}`,
        short: `#${entry.run.run_number} · ${entry.job.name}`,
        tags: [stale ? 'superseded' : '', isMine(entry.run, login) ? 'you' : ''].filter(Boolean),
        note: note(usualEnd, guessed, nowMs),
      },
      title:
        `${entry.repo.owner}/${entry.repo.name} #${entry.run.run_number} ${entry.job.name}, running ${age(entry.since, nowMs)}` +
        (f?.typical ? `, usually ${f.guessed ? '~' : ''}${duration(f.typical)}${f.guessed ? ' (a guess)' : ''}` : ''),
    }
  }
  if (bucket.running.length <= MAX_RUNNING_ROWS) return groups.flatMap((g) => g.jobs.map((p) => one(p.entry)))

  // A large pool: one row per run, from its first start to its last usual end.
  return groups.map((g) => {
    const fs = g.jobs.map((p) => forecast.jobs.get(p.entry.job.id))
    const ends = fs.map((f) => f?.usualEnd ?? null)
    const usualEnd = ends.some((e) => e === null) ? null : Math.max(...(ends as number[]))
    const guessed = fs.some((f) => f?.guessed)
    const first = g.jobs[0]!.entry
    const stale = g.supersededBy !== null
    return {
      key: `r${g.run.id}`,
      series: seriesClass(g.repo),
      stale,
      since: g.since,
      usualEnd,
      guessed,
      caption: {
        label: `${who(first)} · ${g.jobs.length} ${g.jobs.length === 1 ? 'job' : 'jobs'}`,
        short: who(first),
        tags: [stale ? 'superseded' : '', isMine(g.run, login) ? 'you' : ''].filter(Boolean),
        note: note(usualEnd, guessed, nowMs),
      },
      title: `${g.repo.owner}/${g.repo.name} #${g.run.run_number}: ${g.jobs.map((p) => p.entry.job.name).join(', ')}`,
    }
  })
}

function queueRow(
  seg: QueueSegment<DashJob>,
  forecast: BucketForecast,
  nowMs: number,
  login: string | null,
  folded: boolean,
): QueueRow {
  const first = seg.items[0]!
  const fs = seg.items.map((j) => forecast.jobs.get(j.job.id)).filter((f): f is JobForecast => f !== undefined)
  const known = fs.filter((f) => f.start > 0)
  const firstUp = known.reduce<JobForecast | null>((best, f) => (best === null || f.start < best.start ? f : best), null)
  const start = firstUp?.start ?? null
  const end = known.length === fs.length && fs.every((f) => f.end !== null) ? Math.max(...fs.map((f) => f.end!)) : null
  const since = Math.min(...seg.items.map((j) => (j.since > 0 ? j.since : nowMs)))
  const runs = new Set(seg.items.map((j) => j.run.id)).size
  const positions = positionsText(seg.from, seg.to)
  const stale = seg.items.every((j) => j.supersededBy !== null)
  // A folded row holds several runs; the reader's own is never among them.
  const mine = !folded && isMine(first.run, login)
  const identity = folded
    ? `${seg.items.length} more from ${runs} ${runs === 1 ? 'run' : 'runs'}`
    : `${who(first)} · ${seg.items.length === 1 ? first.job.name : `${seg.items.length} jobs`}`
  const note =
    start === null
      ? 'start unknown'
      : start - nowMs < NOW_WINDOW_MS
        ? 'starts now'
        : `${folded ? 'starting' : 'starts'} ~${shortClock(start)}${hedge(firstUp?.basis ?? 'learned')}`
  return {
    key: `q${seg.from}`,
    series: folded ? 'series-0' : seriesClass(first.repo),
    stale,
    mine,
    prefix: positions.length,
    since,
    start,
    end,
    caption: {
      label: `${positions}  ${identity}`,
      short: folded ? undefined : `${positions}  ${who(first)}`,
      tags: [stale ? 'superseded' : '', mine ? 'you' : ''].filter(Boolean),
      note,
    },
    title:
      (seg.from === seg.to ? `Queue position ${seg.from}: ` : `Queue positions ${seg.from} to ${seg.to}: `) +
      seg.items.map((j) => `${who(j)} ${j.job.name}`).join(', ') +
      `, waiting ${age(since, nowMs)}`,
  }
}

export function QueueTimeline({ bucket, forecast, nowMs, login }: Props) {
  const [ref, width] = useWidth()
  const narrow = width < NARROW_W
  const pool = RUNNER_CLASS_LABEL[bucket.cls]
  const hatchId = `tl-hatch-${bucket.cls}`

  // "you" picks the reader's runs out from other people's. In a pool holding
  // only the reader's own runs there is nothing to pick out, so no row is tagged.
  const all = [...bucket.running, ...bucket.queued]
  const others = all.some((j) => !isMine(j.run, login))
  const me = others ? login : null

  const running = runningRows(bucket, forecast, nowMs, me)
  const queue = foldQueue(
    queueSegments(bucket.queued, (j) => j.run.id),
    narrow ? MAX_QUEUE_ROWS_NARROW : MAX_QUEUE_ROWS,
    (seg) => isMine(seg.items[0]!.run, login),
  ).map(({ seg, folded }) => queueRow(seg, forecast, nowMs, me, folded))

  // Far enough ahead for every drawn end and start, within bounds.
  const latest = Math.max(
    nowMs,
    ...running.map((r) => r.usualEnd ?? 0),
    ...queue.map((q) => q.end ?? q.start ?? 0),
  )
  const { tMin, tMax } = timeWindow(nowMs, latest)
  const plotW = width - 2
  const x = (t: number) => 1 + ((Math.min(Math.max(t, tMin), tMax) - tMin) / (tMax - tMin)) * plotW
  const xNow = x(nowMs)

  // Vertical layout, top to bottom.
  let y = 0
  const inUseHead = y
  y += HEAD_H
  const runningTop = y
  y += running.length * PITCH
  const waitingHead = queue.length > 0 ? y : null
  if (queue.length > 0) y += HEAD_H
  const queueTop = y
  y += queue.length * PITCH
  const plotBottom = y - ROW_GAP + 4
  const height = plotBottom + AXIS_H

  const chars = Math.floor(width / CHAR_W)
  const step = tickStep(tMin, tMax)
  const ticks = clockTicks(tMin, tMax, nowMs, step, (NOW_CLEAR_PX / plotW) * (tMax - tMin))
  const anchor = (px: number) => (px < 18 ? 'start' : px > width - 18 ? 'end' : 'middle')

  const open = running.filter((r) => r.usualEnd === null || r.usualEnd <= nowMs).length
  const anyOpen = open > 0
  const anyExpected = running.some((r) => r.usualEnd !== null && r.usualEnd > nowMs)
  const anyGuess = running.some((r) => r.guessed && r.usualEnd !== null && r.usualEnd > nowMs)
  const anyStale = running.some((r) => r.stale) || queue.some((q) => q.stale)
  const anyBox = queue.some((q) => q.start !== null)

  const used = bucket.running.length
  const queued = bucket.queued.length
  // What the drawing says, as data, for anyone who cannot see it.
  const firstStart = queue[0]?.start ?? null
  const summary =
    `${pool}: ${used} of ${forecast.lanes} slots in use, ` +
    (queued === 0 ? 'nothing waiting.' : `${queued} ${queued === 1 ? 'job' : 'jobs'} waiting.`) +
    (firstStart !== null ? ` The first in line should start ~${shortClock(firstStart)}.` : '') +
    (anyOpen ? ` ${open} running with no known end.` : '') +
    ' Every job is also in the list below.'

  const caption = (parts: CaptionParts, top: number, prefix = 0) => {
    const fitted = fitCaption(parts, chars)
    const lead = fitted.label.slice(0, prefix)
    const label = fitted.label.slice(prefix)
    return (
      <text class="tl-caption" x={1} y={top + CAPTION_H - 4}>
        {lead && <tspan class="tl-pos">{lead}</tspan>}
        <tspan>{label}</tspan>
        {fitted.tags.map((t) => (
          <tspan key={t} class={`tl-tag ${t === 'you' ? 'you' : 'stale'}`}>
            {'  '}
            {t}
          </tspan>
        ))}
        {fitted.note && (
          <tspan class="tl-note">
            {'  '}
            {fitted.note}
          </tspan>
        )}
      </text>
    )
  }

  /** The fading edge that stands in for an end nobody can estimate. */
  const tail = (x0: number, top: number, series: string) =>
    [1, 2, 3].map((i) => (
      <rect
        key={`t${i}`}
        class={`tl-tail t${i} ${series}`}
        x={x0 + (i - 1) * TAIL_STEP}
        y={top}
        width={TAIL_STEP}
        height={BAR_H}
      />
    ))

  const hatch = (x1: number, x2: number, top: number) =>
    x2 - x1 > 0 && <rect class="tl-hatch" x={x1} y={top} width={x2 - x1} height={BAR_H} fill={`url(#${hatchId})`} />

  return (
    <figure class="timeline">
      <div class="timeline-plot" ref={ref}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary}>
          <defs>
            <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line class="tl-hatch-line" x1="1" y1="0" x2="1" y2="6" />
            </pattern>
          </defs>

          {ticks.map((t) => (
            <line key={`g${t}`} class="tl-grid" x1={x(t)} x2={x(t)} y1={runningTop} y2={plotBottom} />
          ))}

          <text class="tl-head" x={1} y={inUseHead + 15}>
            IN USE · {used} OF {forecast.lanes} {forecast.lanes === 1 ? 'SLOT' : 'SLOTS'}
          </text>

          {running.map((r, i) => {
            const top = runningTop + i * PITCH
            const by = top + CAPTION_H
            const clipped = r.since > 0 && r.since < tMin
            const xs = x(r.since > 0 ? r.since : nowMs)
            const past = r.usualEnd !== null && r.usualEnd <= nowMs
            const xe = r.usualEnd !== null && !past ? x(r.usualEnd) : xNow
            return (
              <g key={r.key}>
                <title>{r.title}</title>
                <rect class={`tl-run ${r.series}`} x={xs} y={by} width={Math.max(2, xNow - xs)} height={BAR_H} />
                {!past && r.usualEnd !== null && (
                  <rect
                    class={`tl-expect ${r.series}${r.guessed ? ' guess' : ''}`}
                    x={xNow}
                    y={by}
                    width={Math.max(0, xe - xNow)}
                    height={BAR_H}
                  />
                )}
                {(past || r.usualEnd === null) && tail(xNow, by, r.series)}
                {r.stale && hatch(xs, Math.max(xNow, xe), by)}
                {past && r.usualEnd! > tMin && (
                  <line class="tl-usual" x1={x(r.usualEnd!)} x2={x(r.usualEnd!)} y1={by - 2} y2={by + BAR_H + 2} />
                )}
                {clipped && <path class="tl-clip" d={`M${xs + 7} ${by + 2.5} L${xs + 3} ${by + 6} L${xs + 7} ${by + 9.5}`} />}
              </g>
            )
          })}

          {waitingHead !== null && (
            <text class="tl-head waiting" x={1} y={waitingHead + 15}>
              WAITING · {queued} {queued === 1 ? 'JOB' : 'JOBS'} · BY PLACE IN LINE
            </text>
          )}

          {queue.map((q, i) => {
            const top = queueTop + i * PITCH
            const by = top + CAPTION_H
            const mid = by + BAR_H / 2
            const xw = x(q.since)
            const xStart = q.start === null ? null : x(q.start)
            const xEnd = q.end === null ? null : x(q.end)
            return (
              <g key={q.key}>
                <title>{q.title}</title>
                <line class="tl-wait" x1={xw} x2={xNow} y1={mid} y2={mid} />
                {q.since >= tMin && <circle class="tl-wait-dot" cx={xw} cy={mid} r={2.5} />}
                {xStart === null ? (
                  <line class="tl-wait ahead unknown" x1={xNow} x2={Math.min(width - 1, xNow + 40)} y1={mid} y2={mid} />
                ) : (
                  <>
                    {xStart > xNow + 1 && <line class="tl-wait ahead" x1={xNow} x2={xStart} y1={mid} y2={mid} />}
                    {q.start! < tMax &&
                      (xEnd === null ? (
                        tail(xStart, by, q.series)
                      ) : (
                        <rect
                          class={`tl-queued ${q.series}${q.mine ? ' mine' : ''}`}
                          x={xStart}
                          y={by}
                          width={Math.max(3, xEnd - xStart)}
                          height={BAR_H}
                        />
                      ))}
                    {q.stale && xEnd !== null && hatch(xStart, xEnd, by)}
                  </>
                )}
              </g>
            )
          })}

          {/* Now, through the bars only, so it never runs through a caption. */}
          {[...running.map((_, i) => runningTop + i * PITCH), ...queue.map((_, i) => queueTop + i * PITCH)].map((top) => (
            <line key={`n${top}`} class="tl-now" x1={xNow} x2={xNow} y1={top + CAPTION_H - 3} y2={top + CAPTION_H + BAR_H + 3} />
          ))}
          <line class="tl-now" x1={xNow} x2={xNow} y1={plotBottom - 2} y2={plotBottom + 3} />

          {/* Captions last, so neither the now line nor a grid line crosses them. */}
          {running.map((r, i) => (
            <g key={`c${r.key}`}>{caption(r.caption, runningTop + i * PITCH)}</g>
          ))}
          {queue.map((q, i) => (
            <g key={`c${q.key}`}>{caption(q.caption, queueTop + i * PITCH, q.prefix)}</g>
          ))}

          {ticks.map((t) => (
            <text key={t} class="tl-tick" x={x(t)} y={height - 5} text-anchor={anchor(x(t))}>
              {tickClock(t)}
            </text>
          ))}
          <text class="tl-tick now" x={xNow} y={height - 5} text-anchor={anchor(xNow)}>
            now {tickClock(nowMs)}
          </text>
        </svg>
      </div>

      <figcaption class="tl-legend">
        <span>
          <Swatch cls="tl-run series-0" /> run so far
        </span>
        {anyExpected && (
          <span>
            <Swatch cls="tl-expect series-0" /> usual time left
          </span>
        )}
        {anyGuess && (
          <span>
            <Swatch cls="tl-expect series-0 guess" /> guessed
          </span>
        )}
        {anyOpen && (
          <span>
            <Swatch tail /> end not known
          </span>
        )}
        {queue.length > 0 && (
          <span>
            <Swatch wait /> waiting
          </span>
        )}
        {anyBox && (
          <span>
            <Swatch cls="tl-queued series-0" /> expected run
          </span>
        )}
        {anyStale && (
          <span>
            <Swatch cls="tl-run series-0" hatchId={hatchId} /> superseded
          </span>
        )}
      </figcaption>
    </figure>
  )
}

/** A legend key drawn with the very classes of the mark it explains. */
function Swatch({ cls, tail, wait, hatchId }: { cls?: string; tail?: boolean; wait?: boolean; hatchId?: string }) {
  return (
    <svg class="tl-swatch" width="20" height="10" viewBox="0 0 20 10" aria-hidden="true">
      {cls && <rect class={cls} x="1" y="1" width="18" height="8" />}
      {hatchId && <rect class="tl-hatch" x="1" y="1" width="18" height="8" fill={`url(#${hatchId})`} />}
      {tail && (
        <>
          <rect class="tl-run series-0" x="1" y="1" width="8" height="8" />
          <rect class="tl-tail t1 series-0" x="9" y="1" width="4" height="8" />
          <rect class="tl-tail t2 series-0" x="13" y="1" width="3" height="8" />
          <rect class="tl-tail t3 series-0" x="16" y="1" width="3" height="8" />
        </>
      )}
      {wait && (
        <>
          <line class="tl-wait" x1="2" x2="10" y1="5" y2="5" />
          <line class="tl-wait ahead" x1="10" x2="19" y1="5" y2="5" />
          <circle class="tl-wait-dot" cx="2.5" cy="5" r="2" />
        </>
      )}
    </svg>
  )
}
