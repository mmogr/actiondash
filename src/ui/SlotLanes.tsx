import type { BucketForecast, JobForecast } from '../model/forecast'
import type { ClassBucket } from '../model/queue'
import { repoKey } from '../github/types'
import { seriesClass } from './palette'
import { relative } from './format'

/**
 * One row per slot: the job holding it drawn from its start to its expected
 * end, then the queued jobs expected to take it next as dashed outlines, in
 * the order they will start. Answers "which slot frees next, who takes it,
 * and when does mine start" at a glance.
 */

const LABEL_W = 44
const WIDTH = 360
const LANE_H = 22
const LANE_GAP = 4
const AXIS_H = 26
const LOOKBACK_MS = 10 * 60_000
const MIN_AHEAD_MS = 20 * 60_000
const MAX_AHEAD_MS = 60 * 60_000
/** Approximate glyph width at the label size, for deciding whether a label fits. */
const CHAR_W = 6.2

interface Props {
  bucket: ClassBucket
  forecast: BucketForecast
  nowMs: number
}

function fit(label: string, widthPx: number): string | null {
  const room = Math.floor((widthPx - 8) / CHAR_W)
  if (room < 4) return null
  return label.length <= room ? label : `${label.slice(0, room - 1)}…`
}

export function SlotLanes({ bucket, forecast, nowMs }: Props) {
  // Only slots that hold or will take a job are drawn. A Linux pool has twenty
  // and most of them are idle; the idle count is stated instead.
  let highest = -1
  for (const f of forecast.jobs.values()) highest = Math.max(highest, f.lane)
  const lanes = Math.max(1, highest + 1)
  const idle = forecast.lanes - lanes
  const height = lanes * (LANE_H + LANE_GAP) + AXIS_H
  const tMin = nowMs - LOOKBACK_MS
  const wanted = forecast.queueClearsAt === null ? 0 : forecast.queueClearsAt + 2 * 60_000 - nowMs
  const ahead = Math.min(MAX_AHEAD_MS, Math.max(MIN_AHEAD_MS, wanted))
  const tMax = nowMs + ahead
  const plotW = WIDTH - LABEL_W
  const x = (t: number) => LABEL_W + ((Math.min(Math.max(t, tMin), tMax) - tMin) / (tMax - tMin)) * plotW
  const laneY = (i: number) => i * (LANE_H + LANE_GAP)

  const byLane = new Map<number, JobForecast[]>()
  for (const f of forecast.jobs.values()) {
    byLane.set(f.lane, [...(byLane.get(f.lane) ?? []), f])
  }
  const positions = new Map<number, number>()
  bucket.queued.forEach((j, i) => positions.set(j.job.id, i + 1))

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
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        role="img"
        aria-label={`${summary} Queued jobs are shown after the job whose slot they are expected to take.`}
      >
        {Array.from({ length: lanes }, (_, i) => (
          <g key={i}>
            <line class="lane-rule" x1={LABEL_W} x2={WIDTH} y1={laneY(i) + LANE_H} y2={laneY(i) + LANE_H} />
            <text class="lane-label" x={LABEL_W - 8} y={laneY(i) + LANE_H - 7}>
              slot {i + 1}
            </text>
          </g>
        ))}

        {[...byLane.entries()].map(([lane, list]) =>
          list.map((f) => {
            const running = f.start > 0 && f.start <= nowMs && f.entry.job.status === 'in_progress'
            const start = running ? Math.max(f.start, tMin) : f.start
            // An unknown end is drawn a little past now, faded, rather than not at all.
            const end = f.end ?? (running ? nowMs + 2 * 60_000 : start + 2 * 60_000)
            if (start === 0 || start > tMax) return null
            const x1 = x(start)
            const x2 = x(end)
            const w = Math.max(3, x2 - x1)
            const stale = f.entry.supersededBy !== null
            const position = positions.get(f.entry.job.id)
            const label = running
              ? f.entry.job.name
              : `${position ?? ''} · ${f.entry.job.name}`
            const text = fit(label, w)
            const cls = [
              'lane-bar',
              seriesClass(f.entry.repo),
              running ? 'running' : 'ghost',
              stale ? 'stale' : '',
              f.overdue ? 'overdue' : '',
              f.end === null ? 'unknown' : '',
            ]
              .filter(Boolean)
              .join(' ')
            return (
              <g key={f.entry.job.id}>
                <rect class={cls} x={x1} y={laneY(lane) + 1} width={w} height={LANE_H - 2} rx="3">
                  <title>
                    {f.entry.repo.name} #{f.entry.run.run_number} {f.entry.job.name}
                    {running ? '' : `, queue position ${position ?? '?'}`}
                    {f.end === null
                      ? ''
                      : running
                        ? `, expected to finish ${relative(f.end, nowMs)}`
                        : `, expected to start ${relative(f.start, nowMs)}`}
                    {f.guessed ? ' (duration guessed)' : ''}
                  </title>
                </rect>
                {text && (
                  <text
                    class={`lane-text${running ? ' on-bar' : ''}${stale ? ' stale' : ''}`}
                    x={x1 + 5}
                    y={laneY(lane) + LANE_H - 7}
                  >
                    {text}
                  </text>
                )}
              </g>
            )
          }),
        )}

        <line class="lane-now" x1={x(nowMs)} x2={x(nowMs)} y1={0} y2={laneY(lanes) - LANE_GAP + 2} />

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
