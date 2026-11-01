import type { RunnerClass, WorkflowJob } from '../github/types'
import { jobRunnerClass } from '../model/runnerClass'
import { nodeState, type GraphNode, type NodeState, type RunGraph } from '../model/workflow'

/**
 * Where each node of a run's graph is drawn: columns by how many stages come
 * before it, the way GitHub's run page lays a workflow out. Pure, so the
 * drawing and its tests share one answer.
 */

export interface NodeView {
  node: GraphNode
  /** What to call it: its job's name, what its jobs' names share, or its name in the file. */
  label: string
  /** The full name or names, for the tooltip, since labels are cut to fit. */
  title: string
  state: NodeState
  jobs: WorkflowJob[]
  /** Jobs of it that still need a slot from this pool, now or later. */
  pools: RunnerClass[]
  column: number
}

export interface Layout {
  columns: NodeView[][]
  /**
   * Leading stages where everything passed, drawn as one node so the graph
   * shows what is left. Null when nothing is folded.
   */
  folded: { jobs: number; stages: number; ids: Set<string> } | null
  /** From node id to node id; from the folded node when `from` is null. */
  edges: { from: string | null; to: string; future: boolean }[]
  /** No job needs another: a set of jobs rather than a graph. */
  flat: boolean
}

const DONE: ReadonlySet<NodeState> = new Set(['passed', 'skipped'])
const ORDER: Record<NodeState, number> = { running: 0, waiting: 1, future: 2, failed: 3, cancelled: 4, passed: 5, skipped: 6 }

/** What a set of names has in common, cut back to a whole word. */
export function sharedName(names: readonly string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]!
  let prefix = names[0]!
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1)
  return prefix.replace(/[\s(/,:_-]+$/, '').trim()
}

function labelOf(node: GraphNode, jobs: readonly WorkflowJob[]): string {
  const fromJobs = sharedName(jobs.map((j) => j.name))
  if (fromJobs) return fromJobs
  if (node.exactNames?.length) return sharedName(node.exactNames) || node.label
  // A job inside a reusable workflow, before it exists: its place in the calls.
  return node.id.includes('.') && node.kind === 'job' ? node.id.split('.').join(' / ') : node.label
}

export function layoutGraph(g: RunGraph): Layout {
  const visible = g.graph.nodes.filter((n) => !g.neverRuns.has(n.id))
  const ids = new Set(visible.map((n) => n.id))
  const depth = new Map<string, number>()
  const byId = new Map(visible.map((n) => [n.id, n]))
  const depthOf = (id: string, seen: Set<string> = new Set()): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    if (seen.has(id)) return 0
    seen.add(id)
    const needs = byId.get(id)!.needs.filter((d) => ids.has(d))
    const d = needs.length ? 1 + Math.max(...needs.map((n) => depthOf(n, seen))) : 0
    depth.set(id, d)
    return d
  }
  const views: NodeView[] = visible.map((node) => {
    const jobs = g.instances.get(node.id) ?? []
    const state = nodeState(jobs, node.count)
    const pools = DONE.has(state)
      ? []
      : jobs.length
        ? jobs.filter((j) => j.status !== 'completed').map(jobRunnerClass)
        : (node.classes ?? [])
    return {
      node,
      label: labelOf(node, jobs),
      title: jobs.length ? jobs.map((j) => j.name).join('\n') : (node.exactNames?.join('\n') ?? labelOf(node, jobs)),
      state,
      jobs,
      pools,
      column: depthOf(node.id),
    }
  })
  const levels = Math.max(0, ...views.map((v) => v.column)) + 1
  const flat = levels === 1

  if (flat) {
    const sorted = [...views].sort((a, b) => ORDER[a.state] - ORDER[b.state])
    return { columns: [sorted], folded: null, edges: [], flat: true }
  }

  // Fold leading stages where every job passed or was skipped, while
  // something is left to draw after them.
  let fold = 0
  while (fold < levels - 1 && views.filter((v) => v.column === fold).every((v) => DONE.has(v.state))) fold++
  const foldedIds = new Set(views.filter((v) => v.column < fold).map((v) => v.node.id))
  const shift = fold > 0 ? fold - 1 : 0
  const columns: NodeView[][] = []
  for (const v of views) {
    if (foldedIds.has(v.node.id)) continue
    v.column -= shift
    ;(columns[v.column] ??= []).push(v)
  }
  for (const col of columns) col?.sort((a, b) => a.label.localeCompare(b.label))

  const edges: Layout['edges'] = []
  const seen = new Set<string>()
  for (const v of views) {
    if (foldedIds.has(v.node.id)) continue
    for (const dep of v.node.needs) {
      if (!ids.has(dep)) continue
      const from = foldedIds.has(dep) ? null : dep
      const key = `${from}>${v.node.id}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ from, to: v.node.id, future: v.state === 'future' })
    }
  }
  return {
    columns: columns.map((c) => c ?? []),
    folded: fold > 0 ? { jobs: views.filter((v) => foldedIds.has(v.node.id)).reduce((n, v) => n + Math.max(1, v.jobs.length), 0), stages: fold, ids: foldedIds } : null,
    edges,
    flat: false,
  }
}

/** "1st", "2nd", "3rd", "11th". */
export function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}
