import { useState } from 'preact/hooks'
import { gaps, type Sample } from '../../model/history'
import type { RunnerClass } from '../../github/types'
import { duration, shortClock } from '../format'

/**
 * Slots in use over time as a step area, with the queue stacked above it and
 * the ceiling as a dashed line. Silences are hatched, never interpolated.
 * Drag or hover to read one moment.
 */

const WIDTH = 360
const HEIGHT = 170
const LEFT = 28
const RIGHT = 6
const TOP = 10
const BOTTOM = 26

interface Props {
  samples: readonly Sample[]
  cls: RunnerClass
  cap: number | null
  fromMs: number
  toMs: number
}

type Point = [number, number]

function segments(samples: readonly Sample[]): Sample[][] {
  const out: Sample[][] = []
  let current: Sample[] = []
  for (const s of samples) {
    current.push(s)
    if (s.gap) {
      out.push(current)
      current = []
    }
  }
  if (current.length > 0) out.push(current)
  return out
}

export function OccupancyChart({ samples, cls, cap, fromMs, toMs }: Props) {
  const [scrub, setScrub] = useState<number | null>(null)

  const plotW = WIDTH - LEFT - RIGHT
  const plotH = HEIGHT - TOP - BOTTOM
  const inUseOf = (s: Sample) => s.inUse[cls] ?? 0
  const queuedOf = (s: Sample) => s.queued[cls] ?? 0
  const peak = Math.max(cap ?? 0, ...samples.map((s) => inUseOf(s) + queuedOf(s)), 1)
  const yMax = Math.max(2, Math.ceil(peak / 2) * 2)
  const yTicks = [...new Set([0, ...(cap !== null && cap < yMax ? [cap] : []), yMax])]
  const x = (t: number) => LEFT + ((t - fromMs) / (toMs - fromMs)) * plotW
  const y = (v: number) => TOP + plotH - (v / yMax) * plotH

  // A step path holds each reading until the next one arrives.
  const stepTop = (seg: Sample[], value: (s: Sample) => number): Point[] => {
    const pts: Point[] = []
    seg.forEach((s, i) => {
      if (i === 0) pts.push([x(s.t), y(value(s))])
      else pts.push([x(s.t), y(value(seg[i - 1]!))], [x(s.t), y(value(s))])
    })
    const last = seg[seg.length - 1]!
    pts.push([x(last.until), y(value(last))])
    return pts
  }
  const polygon = (top: Point[], bottom: Point[]) =>
    [...top, ...bottom.slice().reverse()].map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ')

  const segs = segments(samples)
  const silences = gaps(samples)

  // Ticks: a handful of round clock times across the window.
  const span = toMs - fromMs
  const stepMs =
    span <= 3_600_000 ? 15 * 60_000 : span <= 6 * 3_600_000 ? 3_600_000 : span <= 86_400_000 ? 6 * 3_600_000 : 86_400_000
  const ticks: number[] = []
  for (let t = Math.ceil(fromMs / stepMs) * stepMs; t < toMs; t += stepMs) ticks.push(t)
  const tickLabel = (t: number) =>
    span > 86_400_000
      ? new Date(t).toLocaleDateString(undefined, { weekday: 'short' })
      : span <= 3_600_000
        ? shortClock(t)
        : new Date(t).toLocaleTimeString(undefined, { hour: 'numeric' })

  const at = scrub === null ? null : samples.find((s) => scrub >= s.t && scrub <= s.until) ?? null
  const scrubX = scrub === null ? null : x(scrub)
  const tipLeft = scrubX !== null && scrubX > WIDTH - 130

  const readPointer = (e: PointerEvent) => {
    const svg = e.currentTarget as SVGSVGElement
    const rect = svg.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * WIDTH
    if (px < LEFT || px > WIDTH - RIGHT) return setScrub(null)
    setScrub(fromMs + ((px - LEFT) / plotW) * span)
  }

  const summary =
    samples.length === 0
      ? 'No data in this window.'
      : `Up to ${peak} at once${cap === null ? '' : ` against a ceiling of ${cap}`}.`

  return (
    <svg
      class="occ"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={`Slots in use over time. ${summary}`}
      onPointerMove={readPointer}
      onPointerDown={readPointer}
      onPointerLeave={() => setScrub(null)}
    >
      <defs>
        <pattern id="occ-gap" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" class="occ-hatch" />
        </pattern>
      </defs>

      {yTicks.map((v) => (
        <g key={v}>
          <line class="occ-grid" x1={LEFT} x2={WIDTH - RIGHT} y1={y(v)} y2={y(v)} />
          <text class="occ-axis" x={LEFT - 6} y={y(v) + 3.5} text-anchor="end">
            {v}
          </text>
        </g>
      ))}

      {segs.map((seg, i) => {
        const first = seg[0]!
        const last = seg[seg.length - 1]!
        const inUse = stepTop(seg, inUseOf)
        const stacked = stepTop(seg, (s) => inUseOf(s) + queuedOf(s))
        const base: Point[] = [
          [x(first.t), y(0)],
          [x(last.until), y(0)],
        ]
        return (
          <g key={i}>
            <polygon class="occ-queued" points={polygon(stacked, inUse)} />
            <polygon class="occ-inuse" points={polygon(inUse, base)} />
            <polyline class="occ-line" points={inUse.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ')} />
          </g>
        )
      })}

      {silences.map(([a, b]) => (
        <rect key={a} class="occ-silence" x={x(a)} y={TOP} width={Math.max(2, x(b) - x(a))} height={plotH} />
      ))}

      {cap !== null && (
        <g>
          <line class="occ-cap" x1={LEFT} x2={WIDTH - RIGHT} y1={y(cap)} y2={y(cap)} />
          <text class="occ-axis" x={WIDTH - RIGHT} y={y(cap) - 4} text-anchor="end">
            cap {cap}
          </text>
        </g>
      )}

      {ticks.map((t) => (
        <text key={t} class="occ-axis" x={x(t)} y={HEIGHT - 8} text-anchor="middle">
          {tickLabel(t)}
        </text>
      ))}

      {scrubX !== null && (
        <g class="occ-scrub">
          <line x1={scrubX} x2={scrubX} y1={TOP} y2={TOP + plotH} />
          {at && (
            <>
              <circle cx={scrubX} cy={y(inUseOf(at))} r="4" class="occ-dot inuse" />
              <circle cx={scrubX} cy={y(inUseOf(at) + queuedOf(at))} r="4" class="occ-dot queued" />
            </>
          )}
          <g transform={`translate(${tipLeft ? scrubX - 124 : scrubX + 8} ${TOP})`}>
            <rect class="occ-tip" width="116" height={at ? 34 : 20} rx="5" />
            <text class="occ-tip-text" x="8" y="13">
              {shortClock(scrub!)}
              {at ? '' : ' · no data'}
            </text>
            {at && (
              <text class="occ-tip-text dim" x="8" y="27">
                {inUseOf(at)} in use · {queuedOf(at)} queued
              </text>
            )}
          </g>
        </g>
      )}

      {samples.length === 0 && (
        <text class="occ-axis" x={LEFT + plotW / 2} y={TOP + plotH / 2} text-anchor="middle">
          nothing recorded in this window
        </text>
      )}
    </svg>
  )
}

/** "2h 05m" style total for a card header. */
export function spanText(ms: number): string {
  return duration(ms / 1000)
}
