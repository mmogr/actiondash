import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { BucketForecast, JobForecast } from '../model/forecast'
import type { ClassBucket } from '../model/queue'
import { repoKey } from '../github/types'
import { seriesClass } from './palette'
import { relative } from './format'
import { mergeNarrow, placeLabel, type Placement } from './lanes'

/**
 * One row per slot: the job holding it drawn from its start to its expected
 * end, then the queued jobs expected to take it next as dashed outlines, in
 * the order they will start. Answers "which slot frees next, who takes it,
 * and when does mine start" at a glance.
 *
 * Drawn at the width it is given, one unit to a pixel, so text stays at its
 * set size and a wider screen buys a longer, more legible timeline rather
 * than larger letters.
 */

const LABEL_W = 50
/** Below this width the slot labels shrink to their numbers, to leave room for names. */
const NARROW_W = 480
const NARROW_LABEL_W = 22
/** On a narrow screen, the running job's name gets a line of its own above the bar. */
const CAPTION_H = 14
/** Width of one character of the 11px caption. */
const CAPTION_CHAR_W = 6.6
const LANE_H = 22
const LANE_GAP = 4
const AXIS_H = 26
const LOOKBACK_MS = 10 * 60_000
const MIN_AHEAD_MS = 20 * 60_000
const MAX_AHEAD_MS = 60 * 60_000
/** Queued bars narrower than this, in a row, are drawn as one mark. */
const MIN_GHOST_W = 18
const FALLBACK_W = 360
const MAX_W = 1200

interface Props {
  bucket: ClassBucket
  forecast: BucketForecast
  nowMs: number
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

interface Mark {
  key: number
  series: string
  items: JobForecast[]
  running: boolean
  x1: number
  x2: number
  cls: string
  title: string
  label: string
  short: string | null
  stale: boolean
}

function describe(f: JobForecast): string {
  return `${f.entry.repo.name} #${f.entry.run.run_number} ${f.entry.job.name}`
}

export function SlotLanes({ bucket, forecast, nowMs }: Props) {
  const [ref, width] = useWidth()
  const narrow = width < NARROW_W
  const labelW = narrow ? NARROW_LABEL_W : LABEL_W
  const captionH = narrow ? CAPTION_H : 0
  const pitch = captionH + LANE_H + LANE_GAP

  // Only slots that hold or will take a job are drawn. A Linux pool has twenty
  // and most of them are idle; the idle count is stated instead.
  let highest = -1
  for (const f of forecast.jobs.values()) highest = Math.max(highest, f.lane)
  const lanes = Math.max(1, highest + 1)
  const idle = forecast.lanes - lanes
  const height = lanes * pitch + AXIS_H
  const tMin = nowMs - LOOKBACK_MS
  const wanted = forecast.queueClearsAt === null ? 0 : forecast.queueClearsAt + 2 * 60_000 - nowMs
  const ahead = Math.min(MAX_AHEAD_MS, Math.max(MIN_AHEAD_MS, wanted))
  const tMax = nowMs + ahead
  const plotW = width - labelW
  const x = (t: number) => labelW + ((Math.min(Math.max(t, tMin), tMax) - tMin) / (tMax - tMin)) * plotW
  const laneY = (i: number) => i * pitch
  const barY = (i: number) => laneY(i) + captionH

  const positions = new Map<number, number>()
  bucket.queued.forEach((j, i) => positions.set(j.job.id, i + 1))

  // Each lane's marks, left to right: the running job, then who takes the slot.
  const byLane = new Map<number, Mark[]>()
  const perLane = new Map<number, { running: JobForecast[]; queued: { item: JobForecast; x1: number; x2: number }[] }>()
  for (const f of forecast.jobs.values()) {
    const running = f.start > 0 && f.start <= nowMs && f.entry.job.status === 'in_progress'
    const start = running ? Math.max(f.start, tMin) : f.start
    if (start === 0 || start > tMax) continue
    // An unknown end is drawn a little past now, faded, rather than not at all.
    const end = f.end ?? (running ? nowMs + 2 * 60_000 : start + 2 * 60_000)
    const lane = perLane.get(f.lane) ?? { running: [], queued: [] }
    perLane.set(f.lane, lane)
    if (running) lane.running.push(f)
    else lane.queued.push({ item: f, x1: x(start), x2: x(end) })
  }

  for (const [lane, { running, queued }] of perLane) {
    const marks: Mark[] = running.map((f) => {
      const x1 = x(Math.max(f.start, tMin))
      const x2 = x(f.end ?? nowMs + 2 * 60_000)
      const stale = f.entry.supersededBy !== null
      return {
        key: f.entry.job.id,
        series: seriesClass(f.entry.repo),
        items: [f],
        running: true,
        x1,
        x2: Math.max(x1 + 3, x2),
        cls: [
          'lane-bar',
          seriesClass(f.entry.repo),
          'running',
          stale ? 'stale' : '',
          f.overdue ? 'overdue' : '',
          f.end === null ? 'unknown' : '',
        ]
          .filter(Boolean)
          .join(' '),
        title:
          `${describe(f)}` +
          (f.end === null ? '' : `, expected to finish ${relative(f.end, nowMs)}`) +
          (f.guessed ? ' (duration guessed)' : ''),
        label: f.entry.job.name,
        short: null,
        stale,
      }
    })

    queued.sort((a, b) => a.x1 - b.x1)
    for (const span of mergeNarrow(queued, MIN_GHOST_W)) {
      const items = span.items
      const first = items[0]!
      const stale = items.every((f) => f.entry.supersededBy !== null)
      const oneRepo = items.every((f) => repoKey(f.entry.repo) === repoKey(first.entry.repo))
      const position = (f: JobForecast) => positions.get(f.entry.job.id) ?? '?'
      marks.push({
        key: first.entry.job.id,
        series: oneRepo ? seriesClass(first.entry.repo) : 'series-0',
        items,
        running: false,
        x1: span.x1,
        x2: Math.max(span.x1 + 4, span.x2),
        cls: ['lane-bar', oneRepo ? seriesClass(first.entry.repo) : 'series-0', 'ghost', stale ? 'stale' : '']
          .filter(Boolean)
          .join(' '),
        title:
          items.length === 1
            ? `${describe(first)}, queue position ${position(first)}` +
              (first.end === null ? '' : `, expected to start ${relative(first.start, nowMs)}`) +
              (first.guessed ? ' (duration guessed)' : '')
            : `${items.length} short queued jobs: ${items.map((f) => `${position(f)}. ${describe(f)}`).join('; ')}`,
        label: items.length === 1 ? `${position(first)} · ${first.entry.job.name}` : `${items.length} queued`,
        short: items.length === 1 ? String(position(first)) : String(items.length),
        stale,
      })
    }
    byLane.set(lane, marks.sort((a, b) => a.x1 - b.x1))
  }

  // Labels, left to right in each lane, each taking only the empty track
  // before the next mark and after whatever the previous label used.
  const placed = new Map<number, Placement | null>()
  const captions = new Map<number, { text: string; stale: boolean }>()
  for (const [lane, marks] of byLane) {
    let cursor = labelW
    marks.forEach((m, i) => {
      if (narrow && m.running) {
        const chars = Math.floor((width - labelW) / CAPTION_CHAR_W)
        const text = m.label.length <= chars ? m.label : `${m.label.slice(0, chars - 1)}…`
        captions.set(lane, { text, stale: m.stale })
        cursor = m.x2
        return
      }
      const next = marks[i + 1]?.x1 ?? width
      const p = placeLabel(m.label, { x1: m.x1, x2: m.x2, before: m.x1 - cursor, after: next - m.x2 }, m.short)
      placed.set(m.key, p)
      // A label after the bar takes the gap it sits in.
      cursor = p?.spot === 'after' ? next : m.x2
    })
  }

  // Ticks every five minutes, or ten past half an hour ahead.
  const stepMs = ahead > 30 * 60_000 ? 10 * 60_000 : 5 * 60_000
  const ticks: number[] = []
  for (let t = nowMs - LOOKBACK_MS; t <= tMax + 1; t += stepMs) ticks.push(t)

  const repos = new Map<string, { name: string; cls: string }>()
  for (const f of forecast.jobs.values()) {
    const key = repoKey(f.entry.repo)
    if (!repos.has(key)) repos.set(key, { name: f.entry.repo.name, cls: seriesClass(f.entry.repo) })
  }
  const anyQueued = bucket.queued.length > 0
  const anyOverdue = [...forecast.jobs.values()].some((f) => f.overdue)
  const anyStale = [...forecast.jobs.values()].some((f) => f.entry.supersededBy !== null)

  const used = bucket.running.length
  const total = forecast.lanes
  const summary =
    forecast.nextSlotAt === null
      ? `${used} of ${total} slots in use.`
      : used < total
        ? `${used} of ${total} slots in use, ${total - used} free now.`
        : `All ${total} slots in use. The next frees ${relative(forecast.nextSlotAt, nowMs)}.`

  return (
    <figure class="lanes">
      <div class="lanes-plot" ref={ref}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${summary} Queued jobs are shown after the job whose slot they are expected to take.`}
        >
          {Array.from({ length: lanes }, (_, i) => (
            <g key={i}>
              <line class="lane-rule" x1={labelW} x2={width} y1={barY(i) + LANE_H} y2={barY(i) + LANE_H} />
              <text class="lane-label" x={labelW - 8} y={barY(i) + LANE_H - 7}>
                {narrow ? i + 1 : `slot ${i + 1}`}
              </text>
            </g>
          ))}

          {[...byLane.entries()].map(([lane, marks]) =>
            marks.map((m) => (
              <rect
                key={m.key}
                class={m.cls}
                x={m.x1}
                y={barY(lane) + 1}
                width={m.x2 - m.x1}
                height={LANE_H - 2}
                rx="3"
              >
                <title>{m.title}</title>
              </rect>
            )),
          )}

          <line class="lane-now" x1={x(nowMs)} x2={x(nowMs)} y1={0} y2={laneY(lanes) - LANE_GAP + 2} />

          {/* Labels last, so neither the now line nor a later bar crosses them. */}
          {[...byLane.entries()].map(([lane, marks]) =>
            marks.map((m) => {
              const p = placed.get(m.key)
              if (!p) return null
              const onBar = p.spot === 'on-bar'
              // White on a running bar, whatever the run; red for a superseded
              // run only where the text sits on the track, never on colour.
              const textCls = [
                'lane-text',
                onBar && m.running ? `on-bar ${m.series}` : '',
                m.stale && !(onBar && m.running) ? 'stale' : '',
              ]
                .filter(Boolean)
                .join(' ')
              return (
                <text key={m.key} class={textCls} x={p.x} y={barY(lane) + LANE_H - 7} text-anchor={p.anchor}>
                  {p.text}
                </text>
              )
            }),
          )}

          {[...captions.entries()].map(([lane, c]) => (
            <text key={`caption-${lane}`} class={`lane-caption${c.stale ? ' stale' : ''}`} x={labelW} y={laneY(lane) + captionH - 3}>
              {c.text}
            </text>
          ))}

          {ticks.map((t) => {
            const delta = Math.round((t - nowMs) / 60_000)
            const label = delta === 0 ? 'now' : delta < 0 ? `${delta}m` : `+${delta}`
            return (
              <text
                key={t}
                class={`lane-tick${delta === 0 ? ' now' : ''}`}
                x={x(t)}
                y={height - 8}
                text-anchor={t === tMin ? 'start' : t >= tMax ? 'end' : 'middle'}
              >
                {label}
              </text>
            )
          })}
        </svg>
      </div>

      <figcaption class="lane-legend">
        {[...repos.values()].map((r) => (
          <span key={r.name}>
            <span class={`swatch ${r.cls}`} /> {r.name}
          </span>
        ))}
        {anyQueued && (
          <span>
            <span class="swatch ghost" /> queued, in start order
          </span>
        )}
        {anyStale && (
          <span>
            <span class="swatch ghost stale" /> superseded
          </span>
        )}
        {anyOverdue && (
          <span>
            <span class="swatch overdue" /> past its usual length
          </span>
        )}
        {idle > 0 && (
          <span>
            and {idle} idle slot{idle === 1 ? '' : 's'}
          </span>
        )}
      </figcaption>
    </figure>
  )
}
