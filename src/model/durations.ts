import type { RepoRef, RunnerClass, WorkflowJob } from '../github/types'
import { jobRunnerClass } from './runnerClass'

/**
 * What a job usually takes, learned from the jobs the dashboard has watched
 * finish. GitHub reports a job's start and end once it completes, and jobs
 * that finish inside a still-active run are already in every poll, so most of
 * this costs nothing extra to collect.
 *
 * Everything here is pure. Persistence lives in state/durations.ts.
 */

/** Durations kept per job name. Enough to see a range, few enough to forget a regression. */
export const KEEP = 10
/** Job names remembered before the least recently seen is dropped. */
export const MAX_KEYS = 300

export interface DurationRecord {
  /** Seconds each kept run took, oldest first. */
  secs: number[]
  /** The job id behind each kept duration, so a job is never counted twice. */
  ids: number[]
  cls: RunnerClass
  /** Epoch ms the record was last added to, for eviction. */
  seenAt: number
}

export type DurationMap = Record<string, DurationRecord>

/** The key is the repository and the job name: the same name in two repositories is two jobs. */
export function durationKey(repo: RepoRef, jobName: string): string {
  return `${repo.owner}/${repo.name}::${jobName}`
}

function seconds(job: WorkflowJob): number | null {
  if (!job.started_at || !job.completed_at) return null
  const start = Date.parse(job.started_at)
  const end = Date.parse(job.completed_at)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null
  return Math.round((end - start) / 1000)
}

/**
 * Folds every successful job in the list into the map. Returns the same map
 * when nothing new was learned, so callers can skip a storage write.
 *
 * Only a success says how long the job takes. A cancelled job's duration is
 * how long someone waited before giving up, and a failed one stopped wherever
 * it broke: a test that fails in two minutes would drag "usually" down and
 * make every forecast behind it optimistic.
 */
export function recordCompleted(
  map: DurationMap,
  repo: RepoRef,
  jobs: readonly WorkflowJob[],
  nowMs: number,
): DurationMap {
  let next: DurationMap | null = null
  for (const job of jobs) {
    if (job.status !== 'completed' || job.conclusion !== 'success') continue
    const secs = seconds(job)
    if (secs === null) continue
    const key = durationKey(repo, job.name)
    const existing = (next ?? map)[key]
    if (existing?.ids.includes(job.id)) continue

    const record: DurationRecord = existing
      ? {
          secs: [...existing.secs, secs].slice(-KEEP),
          ids: [...existing.ids, job.id].slice(-KEEP),
          cls: existing.cls,
          seenAt: nowMs,
        }
      : { secs: [secs], ids: [job.id], cls: jobRunnerClass(job), seenAt: nowMs }
    next = { ...(next ?? map), [key]: record }
  }
  return next ? evict(next) : map
}

/** Keeps the map bounded by dropping what was seen longest ago. */
function evict(map: DurationMap): DurationMap {
  const keys = Object.keys(map)
  if (keys.length <= MAX_KEYS) return map
  keys.sort((a, b) => (map[a]?.seenAt ?? 0) - (map[b]?.seenAt ?? 0))
  const out: DurationMap = {}
  for (const key of keys.slice(keys.length - MAX_KEYS)) out[key] = map[key]!
  return out
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** The usual duration in seconds, or undefined before anything has been seen. */
export function typicalSeconds(map: DurationMap, key: string): number | undefined {
  return median(map[key]?.secs ?? [])
}

/** The shortest and longest kept run, for saying "usually 11 to 13m" and spotting an outlier. */
export function rangeSeconds(map: DurationMap, key: string): [number, number] | undefined {
  const secs = map[key]?.secs
  if (!secs || secs.length === 0) return undefined
  return [Math.min(...secs), Math.max(...secs)]
}

/**
 * A stand-in for a job never seen before: the median of every job of the same
 * class. Wrong for any particular job, but a queue estimate built from it beats
 * no estimate, and the UI marks it as a guess.
 */
export function fallbackSeconds(map: DurationMap, cls: RunnerClass): number | undefined {
  const typicals: number[] = []
  for (const record of Object.values(map)) {
    if (record.cls !== cls) continue
    const t = median(record.secs)
    if (t !== undefined) typicals.push(t)
  }
  return median(typicals)
}

/** Restores a map from storage, keeping only entries of the right shape. */
export function sanitiseDurations(raw: unknown): DurationMap {
  if (typeof raw !== 'object' || raw === null) return {}
  const out: DurationMap = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const rec = value as Partial<DurationRecord>
    if (!Array.isArray(rec.secs) || !Array.isArray(rec.ids) || typeof rec.cls !== 'string') continue
    const secs = rec.secs.filter((s): s is number => typeof s === 'number' && s >= 0)
    const ids = rec.ids.filter((i): i is number => typeof i === 'number')
    if (secs.length === 0 || secs.length !== ids.length) continue
    out[key] = {
      secs: secs.slice(-KEEP),
      ids: ids.slice(-KEEP),
      cls: rec.cls as RunnerClass,
      seenAt: typeof rec.seenAt === 'number' ? rec.seenAt : 0,
    }
  }
  return out
}
