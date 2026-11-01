import type { RunWithRepo } from '../github/types'
import type { RunGraph as Graph } from '../model/workflow'
import { buckets, graphOutlooks, jobForecast, now, selectedNode } from '../state/store'
import { age, duration, hedge, shortClock } from './format'
import { layoutGraph, ordinal, type NodeView } from './graphLayout'

/**
 * A run drawn as a graph of its jobs, the way GitHub's run page draws it, with
 * two things GitHub's page does not have: the jobs that do not exist yet,
 * dashed, with when they should start, and each waiting job's place in line
 * for a slot shared with every other repository.
 *
 * Nodes are HTML over an SVG layer of edges, so text wraps and cuts the way
 * the rest of the page does and every node is a real button.
 */

const NODE_W = 172
const NODE_H = 46
const COL_GAP = 30
const ROW_GAP = 6
/** Future jobs this close together read as one moment; the later says "then". */
const SAME_MOMENT_MS = 60_000

const STATE_WORD: Record<NodeView['state'], string> = {
  passed: 'passed',
  failed: 'failed',
  skipped: 'skipped',
  cancelled: 'cancelled',
  running: 'running',
  waiting: 'waiting for a slot',
  future: 'not created yet',
}

interface Props {
  run: RunWithRepo
  graph: Graph
  /** Jobs ahead of the selected job in line, to outline. */
  ahead: ReadonlySet<number>
}

/** One-based places in line of waiting jobs, by job id. */
function placesInLine(): Map<number, number> {
  const out = new Map<number, number>()
  for (const b of buckets.value) {
    if (b.cap === null) continue
    b.queued.forEach((e, i) => out.set(e.job.id, i + 1))
  }
  return out
}

export function RunGraph({ run, graph, ahead }: Props) {
  const nowMs = now.value
  const layout = layoutGraph(graph)
  const outlook = graphOutlooks.value.get(run.id)
  const places = placesInLine()
  const selected = selectedNode.value
  const byId = new Map(layout.columns.flat().map((v) => [v.node.id, v]))

  const detail = (v: NodeView): string => {
    const { jobs } = v
    switch (v.state) {
      case 'running': {
        if (jobs.length === 1) {
          const job = jobs[0]!
          const since = job.started_at ? Date.parse(job.started_at) : 0
          const f = jobForecast(job.id)
          return f?.typical ? `${age(since, nowMs)} · usually ${f.guessed ? '~' : ''}${duration(f.typical)}` : age(since, nowMs)
        }
        const counts = { running: 0, waiting: 0 }
        for (const j of jobs) j.status === 'in_progress' ? counts.running++ : j.status !== 'completed' && counts.waiting++
        return [`${counts.running} running`, counts.waiting ? `${counts.waiting} waiting` : null].filter(Boolean).join(' · ')
      }
      case 'waiting': {
        const spots = jobs.map((j) => places.get(j.id)).filter((p): p is number => p !== undefined).sort((a, b) => a - b)
        if (spots.length === 0) return 'starting'
        const first = jobs.find((j) => places.get(j.id) === spots[0])!
        const f = jobForecast(first.id)
        const where = spots.length > 1 ? `${ordinal(spots[0]!)}–${ordinal(spots[spots.length - 1]!)} in line` : `${ordinal(spots[0]!)} in line`
        return f && f.start > 0 ? `${where} · ~${shortClock(f.start)}${hedge(f.basis)}` : where
      }
      case 'future': {
        const f = outlook?.future.get(v.node.id)
        if (!f) return 'not created yet'
        if (f.likelySkipped) return 'will be skipped'
        if (f.start === null) return 'not created yet'
        // A short tail of quick jobs would all read "~10:34"; after the first,
        // say what each follows instead of repeating the minute.
        const before = v.node.needs.map((d) => outlook?.future.get(d)).find((d) => d?.start != null && Math.abs(d.start - f.start!) < SAME_MOMENT_MS)
        if (before) return `then, after ${byId.get(before.node.id)?.label ?? before.node.label}`
        return `starts ~${shortClock(f.start)}${hedge(f.basis)}`
      }
      case 'passed': {
        const took = Math.max(...jobs.map((j) => (j.completed_at && j.started_at ? (Date.parse(j.completed_at) - Date.parse(j.started_at)) / 1000 : 0)))
        return took > 0 ? `passed · ${duration(took)}` : 'passed'
      }
      default:
        return STATE_WORD[v.state]
    }
  }

  const count = (v: NodeView): number | null => {
    const n = v.jobs.length || (outlook?.future.get(v.node.id)?.count ?? v.node.count ?? 1)
    return n > 1 ? n : null
  }

  const node = (v: NodeView, style?: Record<string, string>) => {
    const n = count(v)
    const mac = v.pools.includes('macos')
    const isSelected = selected?.runId === run.id && selected.nodeId === v.node.id
    const isAhead = v.jobs.some((j) => ahead.has(j.id))
    const text = detail(v)
    const classes = ['gnode', `st-${v.state}`, isSelected ? 'selected' : '', isAhead ? 'ahead' : ''].filter(Boolean).join(' ')
    return (
      <button
        key={v.node.id}
        class={classes}
        style={style}
        title={v.title}
        data-node={`${run.id}:${v.node.id}`}
        aria-pressed={isSelected}
        aria-label={`${v.label}${n ? `, ${n} jobs` : ''}: ${STATE_WORD[v.state]}, ${text}${mac ? ', macOS' : ''}`}
        onClick={() => (selectedNode.value = isSelected ? null : { runId: run.id, nodeId: v.node.id })}
      >
        <span class="gnode-line">
          <span class="gmark" aria-hidden="true" />
          <span class="gnode-name">{v.label}</span>
          {n && <span class="gnode-count">×{n}</span>}
          {mac && <span class="gnode-pool">MAC</span>}
        </span>
        <span class="gnode-detail">{text}</span>
      </button>
    )
  }

  if (layout.flat) {
    return (
      <div class="graph flat" role="group" aria-label={`Jobs of ${run.repoName} #${run.run_number}`}>
        {layout.columns[0]!.map((v) => node(v))}
      </div>
    )
  }

  const pos = new Map<string | null, { x: number; y: number }>()
  let rows = layout.folded ? 1 : 0
  layout.columns.forEach((col, c) => {
    col.forEach((v, r) => pos.set(v.node.id, { x: c * (NODE_W + COL_GAP), y: r * (NODE_H + ROW_GAP) }))
    rows = Math.max(rows, col.length)
  })
  if (layout.folded) pos.set(null, { x: 0, y: 0 })
  const width = layout.columns.length * NODE_W + (layout.columns.length - 1) * COL_GAP
  const height = rows * NODE_H + (rows - 1) * ROW_GAP

  return (
    <div class="graph-scroll">
      <div class="graph" role="group" aria-label={`Jobs of ${run.repoName} #${run.run_number}, by stage`} style={{ width: `${width}px`, height: `${height}px` }}>
        <svg width={width} height={height} aria-hidden="true">
          {layout.edges.map((e) => {
            const a = pos.get(e.from)
            const b = pos.get(e.to)
            if (!a || !b) return null
            const x1 = a.x + NODE_W
            const y1 = a.y + NODE_H / 2
            const x2 = b.x
            const y2 = b.y + NODE_H / 2
            const mid = (x1 + x2) / 2
            return (
              <path
                key={`${e.from}>${e.to}`}
                class={`gedge${e.future ? ' future' : ''}`}
                d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
              />
            )
          })}
        </svg>
        {layout.folded && (
          <div class="gnode st-folded" style={{ left: '0px', top: '0px', width: `${NODE_W}px`, height: `${NODE_H}px` }}>
            <span class="gnode-line">
              <span class="gmark" aria-hidden="true" />
              <span class="gnode-name">
                {layout.folded.jobs} {layout.folded.jobs === 1 ? 'job' : 'jobs'} passed
              </span>
            </span>
            <span class="gnode-detail">
              {layout.folded.stages === 1 ? 'first stage' : `first ${layout.folded.stages} stages`}, folded
            </span>
          </div>
        )}
        {layout.columns.flat().map((v) => {
          const p = pos.get(v.node.id)!
          return node(v, { left: `${p.x}px`, top: `${p.y}px`, width: `${NODE_W}px`, height: `${NODE_H}px` })
        })}
      </div>
    </div>
  )
}
