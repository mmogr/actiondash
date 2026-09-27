import { durationKey, KEEP, typicalSeconds, type DurationMap } from '../../model/durations'
import type { BucketForecast } from '../../model/forecast'
import type { ClassBucket } from '../../model/queue'
import { seriesClass } from '../palette'
import { duration } from '../format'

/**
 * For each job the reader is likely to care about right now, the last few
 * successful durations as dots on one axis, with the current run marked. A run sitting past
 * every previous one is either hung or the runner is slow, and that is worth
 * a nudge before the forecast quietly slides.
 *
 * The jobs take anything from seconds to most of an hour, so no one scale in
 * minutes suits them all. Each row is drawn against its own usual time
 * instead, from nothing to twice the usual. The usual then sits at the same
 * place in every row, and a run halfway across one row is as far along as a
 * run halfway across any other. The minutes are in words above each row.
 */

const WIDTH = 360
const HEIGHT = 30
const AXIS_START = 4
const AXIS_END = 352
/** Each row runs to this many times the job's usual length. */
const SPAN = 2
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

  const anyRunning = shown.some((s) => s.elapsed !== null)
  const mid = AXIS_START + (AXIS_END - AXIS_START) / SPAN

  return (
    <section class="section">
      <div class="section-head">
        <div class="section-title">How long jobs take</div>
        <div class="section-stats">
          <span>
            up to {KEEP} successful runs{anyRunning ? ' · current run marked' : ''}
          </span>
        </div>
      </div>
      {shown.length === 0 ? (
        <div class="empty">Nothing learned yet. Durations are learned as jobs finish.</div>
      ) : (
        <div class="strips">
          {shown.map((s) => {
            const lo = Math.min(...s.secs)
            const hi = Math.max(...s.secs)
            const usual = typicalSeconds(durations, s.key) ?? hi
            // A job that takes no time at all still needs a scale.
            const axisMax = Math.max(usual, 1) * SPAN
            const beyond = (sec: number) => sec > axisMax
            const x = (sec: number) => AXIS_START + (Math.min(sec, axisMax) / axisMax) * (AXIS_END - AXIS_START)
            const range = lo === hi ? duration(lo) : `${duration(lo)} to ${duration(hi)}`
            const runs = `${s.secs.length} successful run${s.secs.length === 1 ? '' : 's'}`
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
                  <span class={`strip-usual${s.overdue ? ' warn' : ''}`} title={`From ${runs}: ${range}.`}>
                    usually {duration(usual)}
                  </span>
                </div>
                <svg
                  viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                  role="img"
                  aria-label={`${s.name} usually takes ${duration(usual)}; the last ${runs} took ${range}${label ? `, this run ${label}` : ''}`}
                >
                  <line class="strip-axis" x1={AXIS_START} x2={AXIS_END} y1="19" y2="19" />
                  <line class="strip-guide" x1={mid} x2={mid} y1="12" y2="26" />
                  {s.secs.map((sec, i) =>
                    beyond(sec) ? (
                      // Off the end of the scale: a pointer at the edge, not a dot pretending to be there.
                      <path
                        key={i}
                        class={`strip-dot ${seriesClass(s.repo)}`}
                        d={`M${AXIS_END - 4} 14.5 L${AXIS_END + 4} 19 L${AXIS_END - 4} 23.5 Z`}
                      >
                        <title>{duration(sec)}</title>
                      </path>
                    ) : (
                      <circle key={i} class={`strip-dot ${seriesClass(s.repo)}`} cx={x(sec)} cy="19" r="4">
                        <title>{duration(sec)}</title>
                      </circle>
                    ),
                  )}
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
                    <text class="strip-label" x={AXIS_START} y="8">
                      {label}
                    </text>
                  )}
                </svg>
              </div>
            )
          })}
          <div class="strip-scale" aria-hidden="true">
            <svg viewBox={`0 0 ${WIDTH} 12`}>
              <text x={AXIS_START} y="9">
                0
              </text>
              <text x={mid} y="9" text-anchor="middle">
                usual
              </text>
              <text x={AXIS_END + 4} y="9" text-anchor="end">
                {SPAN}× usual
              </text>
            </svg>
          </div>
        </div>
      )}
    </section>
  )
}
