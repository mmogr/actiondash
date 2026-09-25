import { durationKey, type DurationMap } from '../../model/durations'
import type { BucketForecast } from '../../model/forecast'
import type { ClassBucket } from '../../model/queue'
import { seriesClass } from '../palette'
import { duration } from '../format'

/**
 * For each job the reader is likely to care about right now, the last few
 * durations as dots on one axis, with today's run marked. A run sitting past
 * every previous one is either hung or the runner is slow, and that is worth
 * a nudge before the forecast quietly slides.
 */

const WIDTH = 360
const HEIGHT = 30
const AXIS_END = 322
const MAX_STRIPS = 6

interface Props {
  durations: DurationMap
  buckets: readonly ClassBucket[]
  forecasts: ReadonlyMap<string, { forecast: BucketForecast }>
  nowMs: number
}

interface Strip {
  key: string
  repo: { owner: string; name: string }
  name: string
  secs: number[]
  /** Elapsed seconds of the running instance, when there is one. */
  elapsed: number | null
  overdue: boolean
  queued: boolean
}

export function DurationStrips({ durations, buckets, forecasts, nowMs }: Props) {
  const strips: Strip[] = []
  const seen = new Set<string>()
  const add = (key: string, repo: Strip['repo'], name: string, elapsed: number | null, overdue: boolean, queued: boolean) => {
    if (seen.has(key)) return
    const record = durations[key]
    if (!record) return
    seen.add(key)
    strips.push({ key, repo, name, secs: record.secs, elapsed, overdue, queued })
  }

  // Running jobs first, then queued, then whatever was seen most recently.
  for (const b of buckets) {
    const f = forecasts.get(b.cls)?.forecast
    for (const j of b.running) {
      const key = durationKey(j.repo, j.job.name)
      const elapsed = j.since > 0 ? (nowMs - j.since) / 1000 : null
      add(key, j.repo, j.job.name, elapsed, f?.jobs.get(j.job.id)?.overdue ?? false, false)
    }
  }
  for (const b of buckets) {
    for (const j of b.queued) add(durationKey(j.repo, j.job.name), j.repo, j.job.name, null, false, true)
  }
  const rest = Object.entries(durations).sort((a, b) => b[1].seenAt - a[1].seenAt)
  for (const [key] of rest) {
    if (strips.length >= MAX_STRIPS) break
    const [repoPart, name] = key.split('::')
    const [owner, repoName] = (repoPart ?? '').split('/')
    add(key, { owner: owner ?? '', name: repoName ?? '' }, name ?? key, null, false, false)
  }
  const shown = strips.slice(0, MAX_STRIPS)

  return (
    <section class="section">
      <div class="section-head">
        <div class="section-title">How long jobs take</div>
        <div class="section-stats">
          <span>last {shown.length > 0 ? '10 runs' : 'runs'} · today marked</span>
        </div>
      </div>
      {shown.length === 0 ? (
        <div class="empty">Nothing learned yet. Durations are learned as jobs finish.</div>
      ) : (
        <div class="strips">
          {shown.map((s) => {
            const lo = Math.min(...s.secs)
            const hi = Math.max(...s.secs)
            const axisMax = Math.max(hi, s.elapsed ?? 0) * 1.15 || 60
            const x = (sec: number) => 4 + (Math.min(sec, axisMax) / axisMax) * (AXIS_END - 8)
            const label =
              s.elapsed !== null
                ? `${duration(s.elapsed)}, ${s.overdue ? 'past usual' : 'running'}`
                : s.queued
                  ? 'queued'
                  : ''
            return (
              <div class="strip" key={s.key}>
                <div class="strip-head">
                  <span class="strip-name" title={s.name}>
                    {s.name} <span class="strip-repo">· {s.repo.name}</span>
                  </span>
                  <span class={`strip-usual${s.overdue ? ' warn' : ''}`}>
                    usually {lo === hi ? duration(lo) : `${duration(lo)} to ${duration(hi)}`}
                  </span>
                </div>
                <svg
                  viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                  role="img"
                  aria-label={`${s.name} usually takes ${duration(lo)} to ${duration(hi)}${label ? `, today ${label}` : ''}`}
                >
                  <line class="strip-axis" x1="4" x2={AXIS_END} y1="19" y2="19" />
                  {s.secs.map((sec, i) => (
                    <circle key={i} class={`strip-dot ${seriesClass(s.repo)}`} cx={x(sec)} cy="19" r="4" />
                  ))}
                  {s.elapsed !== null && (
                    <g>
                      <line class={`strip-today${s.overdue ? ' over' : ''}`} x1={x(s.elapsed)} x2={x(s.elapsed)} y1="10" y2="28" />
                      <text
                        class={`strip-label${s.overdue ? ' over' : ''}`}
                        x={x(s.elapsed) > 220 ? x(s.elapsed) - 6 : x(s.elapsed) + 6}
                        y="8"
                        text-anchor={x(s.elapsed) > 220 ? 'end' : 'start'}
                      >
                        {label}
                      </text>
                    </g>
                  )}
                  {s.elapsed === null && label && (
                    <text class="strip-label" x={x(hi) + 10} y="8">
                      {label}
                    </text>
                  )}
                  <text class="strip-end" x={AXIS_END + 4} y="22" text-anchor="start">
                    {duration(axisMax)}
                  </text>
                </svg>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
