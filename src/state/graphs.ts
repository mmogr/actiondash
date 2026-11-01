import { signal } from '@preact/signals'
import type { JobDef, JobGraph, WorkflowDef } from '../model/workflow'

/**
 * Workflow files, kept parsed and with their ETags, so a run of a workflow the
 * dashboard has already read costs a 304, which the hourly allowance does not
 * count. Keyed by repository and path, not by commit: a contents ETag is the
 * file's blob SHA, so it still matches at any later commit that left the file
 * alone. Holds what the graph needs from each file (job ids, names, needs,
 * matrices, runs-on and step names) and nothing else from the repository.
 */

export const WORKFLOWS_KEY = 'actiondash.workflows.v1'
/** Files remembered before the least recently used is dropped. */
export const MAX_FILES = 200

export interface CachedFile {
  etag: string | null
  /** The parsed file, or null when it was read and is not a workflow. */
  def: WorkflowDef | null
  /** Epoch ms it was last used, for eviction. */
  usedAt: number
}

export type FileCache = Record<string, CachedFile>

export const fileKey = (repo: string, path: string) => `${repo}::${path}`

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

function sanitiseJob(raw: unknown): JobDef | null {
  if (!raw || typeof raw !== 'object') return null
  const j = raw as Partial<JobDef>
  if (typeof j.id !== 'string' || !isStrings(j.needs) || !isStrings(j.steps)) return null
  return {
    id: j.id,
    name: typeof j.name === 'string' ? j.name : null,
    needs: j.needs,
    conditional: j.conditional === true,
    uses: typeof j.uses === 'string' ? j.uses : null,
    matrix: j.matrix ?? null,
    runsOn: j.runsOn ?? null,
    steps: j.steps,
  }
}

/** Keeps only well-formed entries, so corrupt storage reads as a cold cache. */
export function sanitiseFiles(raw: unknown): FileCache {
  if (!raw || typeof raw !== 'object') return {}
  const out: FileCache = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const v = value as Partial<CachedFile>
    if (typeof v.usedAt !== 'number' || !Number.isFinite(v.usedAt)) continue
    let def: WorkflowDef | null = null
    if (v.def) {
      const jobs = Array.isArray(v.def.jobs) ? v.def.jobs.map(sanitiseJob) : []
      if (jobs.some((j) => j === null) || jobs.length === 0) continue
      def = { jobs: jobs as JobDef[] }
    }
    out[key] = { etag: typeof v.etag === 'string' ? v.etag : null, def, usedAt: v.usedAt }
  }
  return out
}

function load(): FileCache {
  try {
    const raw = localStorage.getItem(WORKFLOWS_KEY)
    return raw ? sanitiseFiles(JSON.parse(raw)) : {}
  } catch {
    return {}
  }
}

let files: FileCache = load()

function persist(): void {
  try {
    localStorage.setItem(WORKFLOWS_KEY, JSON.stringify(files))
  } catch {
    // Storage unavailable. Files are read again after a reload, at a request each.
  }
}

export function cachedFile(key: string): CachedFile | undefined {
  return files[key]
}

/** Records a file and drops the least recently used beyond MAX_FILES. */
export function rememberFile(key: string, entry: CachedFile): void {
  files = { ...files, [key]: entry }
  const keys = Object.keys(files)
  if (keys.length > MAX_FILES) {
    const oldest = keys.sort((a, b) => files[a]!.usedAt - files[b]!.usedAt).slice(0, keys.length - MAX_FILES)
    for (const k of oldest) delete files[k]
  }
  persist()
}

/** Marks a file used without rewriting storage on every poll. */
export function touchFile(key: string, nowMs: number): void {
  const entry = files[key]
  if (entry) entry.usedAt = nowMs
}

/** What the dashboard knows about one run's graph. */
export type GraphEntry =
  | { graph: JobGraph; /** The commit or branch the file was read at. */ ref: string }
  | { reason: string }

/**
 * Each active run's graph, or why it has none. A run is asked about once: a
 * file that does not explain its run will not start to, and asking again
 * would spend a request every poll.
 */
export const runGraphs = signal<Map<number, GraphEntry>>(new Map())

/**
 * Opted-in repositories whose workflow files the token could not read, with
 * what GitHub said, so Settings can name them.
 */
export const graphDenied = signal<Map<string, string>>(new Map())

export function clearWorkflowCache(): void {
  files = {}
  runGraphs.value = new Map()
  graphDenied.value = new Map()
  try {
    localStorage.removeItem(WORKFLOWS_KEY)
  } catch {
    // Nothing to remove.
  }
}
