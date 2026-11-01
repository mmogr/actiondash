import { load } from 'js-yaml'
import type { RunnerClass, WorkflowJob } from '../github/types'
import { runnerClass } from './runnerClass'

/**
 * A run's job graph, read from its workflow file and checked against the jobs
 * GitHub lists.
 *
 * GitHub's API never says which job needs which. The workflow file does, so
 * the graph is built from the file and then held to account by the listing:
 * every listed job has to be one the file declares, and every job that waited
 * on others has to have been created the moment the last of them finished.
 * Across 91 runs in 30 repositories that held for all 196 such jobs, within
 * two seconds. A file that does not explain its run is never drawn; the run
 * keeps the plain job list instead.
 *
 * Everything here is pure. Fetching and caching live in state/graphs.ts and
 * the poller.
 */

/** What the dashboard keeps of one job in a workflow file. Small enough to store. */
export interface JobDef {
  id: string
  /** The `name:` as written, expressions and all, or null when the job has none. */
  name: string | null
  needs: string[]
  /** The job has an `if:`, so it may be skipped. */
  conditional: boolean
  /** `uses:` of a job that calls a reusable workflow. */
  uses: string | null
  /** `strategy.matrix` as written. */
  matrix: unknown
  /** `runs-on` as written. */
  runsOn: unknown
  /** Step names as GitHub lists them, where they can be known from the file. */
  steps: string[]
}

export interface WorkflowDef {
  jobs: JobDef[]
}

const EXPR = /\$\{\{[\s\S]*?\}\}/
const EXPR_ALL = /\$\{\{([\s\S]*?)\}\}/g

function strings(value: unknown): string[] {
  if (value == null) return []
  return (Array.isArray(value) ? value : [value]).map(String)
}

/**
 * Reads the parts of a workflow file the graph needs. Null when the text is
 * not YAML or declares no jobs; never throws.
 *
 * js-yaml rather than the `yaml` package: it parsed all 420 workflow files
 * sampled, where `yaml`, and GitHub's own workflow parser built on it,
 * rejected one that GitHub runs. It needs no eval, so the CSP holds.
 */
export function extractWorkflow(text: string): WorkflowDef | null {
  let doc: unknown
  try {
    doc = load(text)
  } catch {
    return null
  }
  if (!doc || typeof doc !== 'object') return null
  const jobs = (doc as { jobs?: unknown }).jobs
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) return null
  const out: JobDef[] = []
  for (const [id, raw] of Object.entries(jobs as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const j = raw as Record<string, unknown>
    const strategy = j.strategy && typeof j.strategy === 'object' ? (j.strategy as Record<string, unknown>) : null
    const steps = Array.isArray(j.steps) ? j.steps : []
    out.push({
      id,
      name: j.name == null ? null : String(j.name),
      needs: strings(j.needs),
      conditional: j.if !== undefined,
      uses: typeof j.uses === 'string' ? j.uses : null,
      matrix: strategy?.matrix ?? null,
      runsOn: j['runs-on'] ?? null,
      steps: steps
        .map((s) => {
          if (!s || typeof s !== 'object') return null
          const step = s as Record<string, unknown>
          // GitHub's own naming for a step with no name.
          if (step.name != null) return String(step.name)
          if (typeof step.uses === 'string') return `Run ${step.uses}`
          if (typeof step.run === 'string') return `Run ${step.run.split('\n')[0]!.trim()}`
          return null
        })
        .filter((n): n is string => n !== null && !EXPR.test(n)),
    })
  }
  return out.length ? { jobs: out } : null
}

type Combo = Record<string, unknown>

/**
 * The combinations of a matrix written out in full, following GitHub's
 * `include` and `exclude` rules, or null when any part of it is an expression
 * and so is only known once the run has computed it.
 */
export function staticCombos(matrix: unknown): Combo[] | null {
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) return null
  if (EXPR.test(JSON.stringify(matrix))) return null
  const { include, exclude, ...axes } = matrix as Record<string, unknown>
  const includes = Array.isArray(include) ? (include as Combo[]) : []
  const excludes = Array.isArray(exclude) ? (exclude as Combo[]) : []
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  let combos: Combo[] = Object.keys(axes).length ? [{}] : []
  for (const [key, values] of Object.entries(axes)) {
    combos = combos.flatMap((c) => (Array.isArray(values) ? values : [values]).map((v) => ({ ...c, [key]: v })))
  }
  combos = combos.filter((c) => !excludes.some((e) => Object.entries(e).every(([k, v]) => same(c[k], v))))
  // An include extends every original combination it does not contradict, and
  // becomes a combination of its own when it extends none. Only the originals
  // are candidates: one include never extends another.
  const originalKeys = new Set(Object.keys(axes))
  const originals = [...combos]
  for (const inc of includes) {
    let extended = false
    for (const c of originals) {
      const clash = Object.entries(inc).some(([k, v]) => originalKeys.has(k) && !same(c[k], v))
      if (clash) continue
      for (const [k, v] of Object.entries(inc)) if (!originalKeys.has(k)) c[k] = v
      extended = true
    }
    if (!extended) combos.push({ ...inc })
  }
  return combos
}

/**
 * A name or label with its `${{ matrix.x }}` references filled in, or null when
 * it uses anything else, which only the run itself can evaluate.
 */
export function evaluate(template: string, combo: Combo): string | null {
  let ok = true
  const out = template.replace(EXPR_ALL, (_, inner: string) => {
    const ref = /^\s*matrix\.([\w-]+)\s*$/.exec(inner)
    if (!ref || !(ref[1]! in combo)) {
      ok = false
      return ''
    }
    const value = combo[ref[1]!]
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  })
  return ok ? out : null
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A name template as a pattern: literal text, with each expression standing for anything. */
const templatePattern = (t: string) => t.split(EXPR).map(escapeRe).join('.*?')

/** The labels a job will run on, per matrix combination, or null when that depends on the run. */
function runsOnLabels(runsOn: unknown, combo: Combo): string[] | null {
  if (runsOn == null) return null
  if (typeof runsOn === 'string') {
    const whole = /^\s*\$\{\{\s*matrix\.([\w-]+)\s*\}\}\s*$/.exec(runsOn)
    if (whole) {
      const value = combo[whole[1]!]
      return value == null ? null : strings(value)
    }
    const v = evaluate(runsOn, combo)
    return v === null ? null : [v]
  }
  if (Array.isArray(runsOn)) {
    const out: string[] = []
    for (const label of runsOn) {
      const v = evaluate(String(label), combo)
      if (v === null) return null
      out.push(v)
    }
    return out
  }
  if (typeof runsOn === 'object') {
    // A runner group is the organisation's own capacity; labels within it are
    // still labels.
    const labels = (runsOn as { labels?: unknown }).labels
    return labels == null ? ['self-hosted'] : runsOnLabels(labels, combo)
  }
  return null
}

/** A node of the graph: one declared job, which a matrix can turn into many. */
export interface GraphNode {
  /** Unique within the graph: the job's id, dotted through any reusable workflows that call it. */
  id: string
  /** A readable name for the node before any instance exists. */
  label: string
  /** Ids of the nodes this one waits for. */
  needs: string[]
  /** The job has an `if:`, here or on a workflow call above it. */
  conditional: boolean
  /** Matches the display names GitHub gives this node's jobs. */
  pattern: string
  /** Every name its jobs will have, when the file says so exactly. */
  exactNames: string[] | null
  /** The unevaluated name a skipped matrix job is listed under. */
  rawName: string | null
  steps: string[]
  /** How many jobs to expect, or null when the run decides. */
  count: number | null
  /** The pool of each expected job, or null when the run decides. */
  classes: RunnerClass[] | null
  /**
   * 'caller' stands for a call to a reusable workflow that was skipped, which
   * GitHub lists once under the caller's own name. 'opaque' stands for a
   * called workflow whose file could not be read: all its jobs, unseen.
   */
  kind: 'job' | 'caller' | 'opaque'
  /** For a caller, the prefix of the nodes it calls. */
  calls?: string
}

export interface JobGraph {
  nodes: GraphNode[]
}

/** A workflow file another file calls, at the commit the run used. */
export interface CalledRef {
  repo: string
  path: string
  ref: string
}

export const calledKey = (r: CalledRef) => `${r.repo}/${r.path}@${r.ref}`

/** One entry of a run's `referenced_workflows`. */
export interface ReferencedWorkflow {
  path: string
  sha: string
  ref?: string
}

/**
 * Where a `uses:` points, at the exact commit when the run says which. The
 * run's referenced_workflows names every called file with its SHA, nested
 * calls included, so the `@ref` written in the file is only a fallback.
 */
export function resolveUses(
  uses: string,
  callerRepo: string,
  referenced: readonly ReferencedWorkflow[],
  headSha: string,
): CalledRef | null {
  const pinned = referenced.map((w) => {
    const [full] = w.path.split('@')
    const parts = full!.split('/')
    return { repo: parts.slice(0, 2).join('/'), path: parts.slice(2).join('/'), sha: w.sha }
  })
  if (uses.startsWith('./')) {
    const path = uses.slice(2).split('@')[0]!
    const hit = pinned.find((p) => p.repo.toLowerCase() === callerRepo.toLowerCase() && p.path === path)
    return { repo: callerRepo, path, ref: hit?.sha ?? headSha }
  }
  const [full, ref] = uses.split('@')
  if (!full || !ref) return null
  const parts = full.split('/')
  if (parts.length < 3) return null
  const repo = parts.slice(0, 2).join('/')
  const path = parts.slice(2).join('/')
  const hit = pinned.find((p) => p.repo.toLowerCase() === repo.toLowerCase() && p.path === path)
  return { repo, path, ref: hit?.sha ?? ref }
}

export interface ExpandContext {
  /** The repository whose workflow this is, as owner/name. */
  repo: string
  headSha: string
  referenced: readonly ReferencedWorkflow[]
  /** A called file: its definition, null when it cannot be read, undefined when not fetched yet. */
  lookup: (key: string) => WorkflowDef | null | undefined
}

/** GitHub allows a reusable workflow to call others up to this deep. */
const MAX_DEPTH = 10

/**
 * Turns a workflow into graph nodes, following calls to reusable workflows.
 * Returns the graph and the called files it still needs; a file not fetched
 * yet stands in as one opaque node until it is.
 */
export function expandGraph(root: WorkflowDef, ctx: ExpandContext): { graph: JobGraph; pending: CalledRef[] } {
  const nodes: GraphNode[] = []
  const pending = new Map<string, CalledRef>()
  // What finishes each call to a reusable workflow, by the caller's id. A job
  // may need a call declared below it, so needs are written down as ids during
  // the walk and resolved through this once it is complete.
  const finishers = new Map<string, string[]>()

  // Returns the ids of the nodes that finish the given workflow, which is what
  // a job needing its caller waits for.
  const walk = (
    wf: WorkflowDef,
    wfRepo: string,
    prefixId: string,
    /** The display-name pattern of every caller above, ending in " / ". */
    prefixRe: string,
    /** The same prefix as literal text, when no caller above has a templated name. */
    prefixText: string | null,
    inheritedNeeds: string[],
    inheritedConditional: boolean,
    depth: number,
  ): string[] => {
    const qualify = (id: string) => (prefixId ? `${prefixId}.${id}` : id)
    const needed = new Set(wf.jobs.flatMap((j) => j.needs))

    for (const job of wf.jobs) {
      const id = qualify(job.id)
      const templated = job.name !== null && EXPR.test(job.name)
      const base = job.name ?? job.id
      const usesMatrix = job.name !== null && /matrix\./.test(job.name)
      const combos = staticCombos(job.matrix)
      const hasMatrix = job.matrix != null
      // A matrix job whose name does not use the matrix gets its values
      // appended in brackets. Their order is not documented, so that is
      // matched as a pattern rather than predicted.
      const suffix = hasMatrix && !usesMatrix ? '(?: \\(.+\\))?' : ''
      const own = `${prefixRe}${templatePattern(base)}${suffix}`
      const needs = job.needs.length ? job.needs.map(qualify) : inheritedNeeds
      const conditional = inheritedConditional || job.conditional

      if (job.uses !== null) {
        const target = depth < MAX_DEPTH ? resolveUses(job.uses, wfRepo, ctx.referenced, ctx.headSha) : null
        const called = target ? ctx.lookup(calledKey(target)) : null
        if (target && called === undefined) pending.set(calledKey(target), target)
        if (target && called) {
          // GitHub lists a skipped call once, under the caller's own name.
          nodes.push(callerNode(id, base, own, needs, conditional))
          const literal = prefixText !== null && !templated && !hasMatrix ? `${prefixText}${base} / ` : null
          finishers.set(id, walk(called, target.repo, id, `${own} / `, literal, needs, conditional, depth + 1))
          continue
        }
        // Not readable, or not fetched yet: everything it runs, as one node.
        nodes.push({
          id,
          label: base,
          needs,
          conditional,
          pattern: `^${own}(?: / .+)?$`,
          exactNames: null,
          rawName: null,
          steps: [],
          count: null,
          classes: null,
          kind: 'opaque',
        })
        continue
      }

      let exactNames: string[] | null = null
      let classes: RunnerClass[] | null = null
      let count: number | null = hasMatrix ? (combos?.length ?? null) : 1
      if (prefixText !== null) {
        if (!hasMatrix && !templated) exactNames = [`${prefixText}${base}`]
        if (combos && usesMatrix) {
          const names = combos.map((c) => evaluate(base, c))
          if (names.every((n) => n !== null)) exactNames = names.map((n) => `${prefixText}${n}`)
        }
      }
      const perCombo = combos ?? (hasMatrix ? null : [{}])
      if (perCombo) {
        const labels = perCombo.map((c) => runsOnLabels(job.runsOn, c))
        if (labels.every((l) => l !== null)) classes = labels.map((l) => runnerClass(l!))
      }
      nodes.push({
        id,
        label: templated ? job.id : base,
        needs,
        conditional,
        pattern: `^${own}$`,
        exactNames,
        rawName: templated && prefixText !== null ? `${prefixText}${job.name}` : null,
        steps: job.steps,
        count,
        classes,
        kind: 'job',
      })
    }

    // What finishes this workflow: the jobs no other job in it waits for.
    return wf.jobs.filter((j) => !needed.has(j.id)).map((j) => qualify(j.id))
  }

  walk(root, ctx.repo, '', '', '', [], false, 0)
  const resolve = (id: string, seen = new Set<string>()): string[] => {
    const via = finishers.get(id)
    if (!via || seen.has(id)) return [id]
    seen.add(id)
    return via.flatMap((f) => resolve(f, seen))
  }
  for (const n of nodes) n.needs = [...new Set(n.needs.flatMap((d) => resolve(d)))]
  return { graph: { nodes: mergeTwins(nodes) }, pending: [...pending.values()] }
}

function callerNode(id: string, base: string, own: string, needs: string[], conditional: boolean): GraphNode {
  return {
    id: `${id}.~`,
    label: base,
    needs,
    conditional,
    pattern: `^${own}$`,
    exactNames: null,
    rawName: null,
    steps: [],
    count: 0,
    classes: [],
    kind: 'caller',
    calls: id,
  }
}

/**
 * Merges nodes nobody could tell apart: the same name pattern, the same
 * needs, the same dependents and no exact names to separate them, such as
 * home-assistant's pytest-mariadb and pytest-postgres, both named
 * "Run ${{ ... }} tests Python ${{ ... }}" from matrices the run computes.
 * Drawn as one node, nothing about the graph or its timing is lost.
 */
function mergeTwins(nodes: GraphNode[]): GraphNode[] {
  const dependents = new Map<string, string[]>()
  for (const n of nodes) for (const d of n.needs) dependents.set(d, [...(dependents.get(d) ?? []), n.id])
  const sig = (n: GraphNode) =>
    // Only templated names can collide: a literal name is unique within a file.
    n.kind === 'job' && n.exactNames === null && n.pattern.includes('.*?')
      ? `${n.pattern}|${[...n.needs].sort().join(',')}|${[...(dependents.get(n.id) ?? [])].sort().join(',')}`
      : null
  const groups = new Map<string, GraphNode[]>()
  for (const n of nodes) {
    const s = sig(n)
    if (s) groups.set(s, [...(groups.get(s) ?? []), n])
  }
  const rename = new Map<string, string>()
  const out: GraphNode[] = []
  const done = new Set<string>()
  for (const n of nodes) {
    if (done.has(n.id)) continue
    const s = sig(n)
    const twins = s ? groups.get(s)! : [n]
    if (twins.length === 1) {
      out.push(n)
      continue
    }
    const merged: GraphNode = {
      ...n,
      id: twins.map((t) => t.id).join('|'),
      label: twins.map((t) => t.label).join(' | '),
      conditional: twins.some((t) => t.conditional),
      steps: [],
      count: null,
      classes: null,
    }
    for (const t of twins) {
      done.add(t.id)
      rename.set(t.id, merged.id)
    }
    out.push(merged)
  }
  if (rename.size === 0) return out
  return out.map((n) => ({ ...n, needs: [...new Set(n.needs.map((d) => rename.get(d) ?? d))] }))
}

/**
 * A listed "job" that is really a check run some step created, such as a
 * link checker posting its own result into the run's check suite. It has no
 * runner, holds no slot and is in no workflow file. Its address is a check
 * run's, not a job's.
 */
export function isCheckRunEntry(job: WorkflowJob): boolean {
  return !/\/actions\/runs\/\d+\/job\/\d+/.test(job.html_url)
}

export interface Match {
  /** Node id by job id. */
  nodeOf: Map<number, string>
  unmatched: WorkflowJob[]
  ambiguous: WorkflowJob[]
  /** Check runs in the listing that are not jobs. */
  notJobs: WorkflowJob[]
}

function stepOverlap(declared: readonly string[], listed: readonly string[]): number {
  if (!declared.length || !listed.length) return 0
  const set = new Set(declared)
  return listed.filter((s) => set.has(s)).length / Math.max(declared.length, listed.length)
}

/** How close a job's creation has to be to the end of what it waited for. */
export const CREATION_TOLERANCE_MS = 2_000

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN)

/**
 * Says which node each listed job belongs to. In order: a skipped matrix job
 * by its raw, unevaluated name; an exact name; a name pattern; where patterns
 * collide, the job's step names, which exist once it has started; and last,
 * when it was created.
 *
 * That last test settles jobs that share a name but not their needs, such as
 * home-assistant's pytest-full and pytest-partial, of which an `if:` runs one:
 * a job is created the moment what it needs has finished, so only one of the
 * candidates' needs ended when it appeared.
 */
export function matchJobs(graph: JobGraph, jobs: readonly WorkflowJob[]): Match {
  const match: Match = { nodeOf: new Map(), unmatched: [], ambiguous: [], notJobs: [] }
  const compiled = graph.nodes.map((n) => ({ n, re: new RegExp(n.pattern, 's'), exact: n.exactNames ? new Set(n.exactNames) : null }))
  const unsure: { job: WorkflowJob; candidates: GraphNode[] }[] = []
  for (const job of jobs) {
    if (isCheckRunEntry(job)) {
      match.notJobs.push(job)
      continue
    }
    const raw = compiled.filter((c) => c.n.rawName === job.name)
    if (raw.length === 1) {
      match.nodeOf.set(job.id, raw[0]!.n.id)
      continue
    }
    let hits = raw.length > 1 ? raw : compiled.filter((c) => c.re.test(job.name) && (!c.exact || c.exact.has(job.name)))
    if (hits.length > 1) {
      const exact = hits.filter((c) => c.exact?.has(job.name))
      if (exact.length === 1) hits = exact
    }
    if (hits.length === 1) {
      match.nodeOf.set(job.id, hits[0]!.n.id)
      continue
    }
    if (hits.length === 0) {
      match.unmatched.push(job)
      continue
    }
    const listedSteps = (job.steps ?? []).map((s) => s.name)
    const scored = hits.map((c) => ({ c, s: stepOverlap(c.n.steps, listedSteps) })).sort((a, b) => b.s - a.s)
    if (scored[0]!.s > 0 && scored[0]!.s > (scored[1]?.s ?? 0)) match.nodeOf.set(job.id, scored[0]!.c.n.id)
    else unsure.push({ job, candidates: hits.map((c) => c.n) })
  }

  // Settle what names could not by when each job was created, using the jobs
  // already placed. Each pass can place jobs the next one needs.
  const byJobId = new Map(jobs.map((j) => [j.id, j]))
  const ends = (nodeId: string): number[] => {
    const out: number[] = []
    for (const [jobId, id] of match.nodeOf) {
      if (id !== nodeId) continue
      const t = time(byJobId.get(jobId)?.completed_at)
      if (!Number.isNaN(t)) out.push(t)
    }
    return out
  }
  let progress = true
  while (unsure.length && progress) {
    progress = false
    for (let i = unsure.length - 1; i >= 0; i--) {
      const { job, candidates } = unsure[i]!
      const created = time(job.created_at)
      const fits = candidates.filter((n) => {
        const gate = n.needs.flatMap(ends)
        if (!gate.length || Number.isNaN(created)) return false
        return Math.abs(created - Math.max(...gate)) <= CREATION_TOLERANCE_MS
      })
      if (fits.length !== 1) continue
      match.nodeOf.set(job.id, fits[0]!.id)
      unsure.splice(i, 1)
      progress = true
    }
  }
  match.ambiguous.push(...unsure.map((u) => u.job))
  return match
}

/** The listed jobs of each node. */
export function instancesOf(graph: JobGraph, jobs: readonly WorkflowJob[], match: Match): Map<string, WorkflowJob[]> {
  const out = new Map<string, WorkflowJob[]>(graph.nodes.map((n) => [n.id, []]))
  for (const job of jobs) {
    const id = match.nodeOf.get(job.id)
    if (id) out.get(id)?.push(job)
  }
  return out
}

export type Verdict = { ok: true } | { ok: false; reason: string }

/**
 * Whether the file explains the run. Every listed job must be one it declares,
 * and every job that waited on others must have been created when the last of
 * them ended. Jobs that were skipped or cancelled are left out of the timing
 * test: cancelling a run creates every job it has not reached at that moment,
 * not when their needs end.
 */
export function validate(graph: JobGraph, jobs: readonly WorkflowJob[], match: Match): Verdict {
  if (match.unmatched.length) return { ok: false, reason: `"${match.unmatched[0]!.name}" is not in the workflow file` }
  if (match.ambiguous.length) return { ok: false, reason: `"${match.ambiguous[0]!.name}" matches more than one job` }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const instances = instancesOf(graph, jobs, match)
  for (const job of jobs) {
    const node = byId.get(match.nodeOf.get(job.id) ?? '')
    if (!node || node.needs.length === 0) continue
    if (job.conclusion === 'skipped' || job.conclusion === 'cancelled') continue
    let gate = -Infinity
    let pendingDep = false
    for (const dep of node.needs) {
      for (const parent of instances.get(dep) ?? []) {
        const end = time(parent.completed_at)
        if (parent.status !== 'completed' || Number.isNaN(end)) pendingDep = true
        else gate = Math.max(gate, end)
      }
    }
    if (pendingDep) return { ok: false, reason: `"${job.name}" exists before what it needs has finished` }
    // Nothing it waits for is listed, as under a skipped call: nothing to test.
    if (gate === -Infinity) continue
    const created = time(job.created_at)
    if (Number.isNaN(created) || Math.abs(created - gate) > CREATION_TOLERANCE_MS) {
      return { ok: false, reason: `"${job.name}" was not created when what it needs finished` }
    }
  }
  return { ok: true }
}

export type NodeState = 'passed' | 'failed' | 'skipped' | 'cancelled' | 'running' | 'waiting' | 'future'

const FAILED = new Set(['failure', 'timed_out', 'startup_failure'])
const RUNNING = new Set(['in_progress'])

/** One job's state in the graph's terms. */
export function jobState(job: WorkflowJob): NodeState {
  if (job.status === 'completed') {
    if (job.conclusion && FAILED.has(job.conclusion)) return 'failed'
    if (job.conclusion === 'skipped' || job.conclusion === 'neutral') return 'skipped'
    if (job.conclusion === 'cancelled') return 'cancelled'
    return 'passed'
  }
  return RUNNING.has(job.status) ? 'running' : 'waiting'
}

/**
 * A node's state from its jobs, most pressing first: anything running, then
 * anything waiting, then anything still to come, then how it ended.
 */
export function nodeState(instances: readonly WorkflowJob[], expected: number | null): NodeState {
  if (instances.length === 0) return 'future'
  const states = instances.map(jobState)
  if (states.includes('running')) return 'running'
  if (states.includes('waiting')) return 'waiting'
  if (expected !== null && instances.length < expected) return 'running'
  if (states.includes('failed')) return 'failed'
  if (states.includes('cancelled')) return 'cancelled'
  if (states.every((s) => s === 'skipped')) return 'skipped'
  return 'passed'
}

/** A validated graph for one run, with its jobs placed. */
export interface RunGraph {
  graph: JobGraph
  /** Listed jobs by node id. */
  instances: Map<string, WorkflowJob[]>
  /** Node ids under a call GitHub skipped, which will never have jobs. */
  neverRuns: Set<string>
  /** Check runs in the listing, kept out of the graph. */
  notJobs: WorkflowJob[]
}

/** Matches, validates and places a run's jobs. Null when the file does not explain the run. */
export function placeJobs(graph: JobGraph, jobs: readonly WorkflowJob[]): RunGraph | Verdict {
  const match = matchJobs(graph, jobs)
  const verdict = validate(graph, jobs, match)
  if (!verdict.ok) return verdict
  const instances = instancesOf(graph, jobs, match)
  const neverRuns = new Set<string>()
  for (const n of graph.nodes) {
    if (n.kind !== 'caller' || !(instances.get(n.id)?.length)) continue
    for (const m of graph.nodes) if (m.id.startsWith(`${n.calls}.`) && m.id !== n.id) neverRuns.add(m.id)
  }
  // The caller stand-ins are only there to be matched; a call that ran shows
  // through the jobs it called.
  for (const n of graph.nodes) if (n.kind === 'caller' && !(instances.get(n.id)?.length)) neverRuns.add(n.id)
  return { graph, instances, neverRuns, notJobs: match.notJobs }
}

export function isRunGraph(x: RunGraph | Verdict | { reason: string }): x is RunGraph {
  return 'graph' in x
}
