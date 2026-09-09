import type { DashJob } from '../model/queue'

/** Compact relative age, e.g. "48s", "14m", "2h 5m", "3d". */
export function age(fromMs: number, nowMs: number): string {
  if (!fromMs) return '-'
  const seconds = Math.max(0, Math.round((nowMs - fromMs) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rem = minutes % 60
    return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`
  }
  return `${Math.floor(hours / 24)}d`
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/** Mean wait of a set of jobs, formatted, or null when the set is empty. */
export function meanAge(jobs: readonly DashJob[], nowMs: number): string | null {
  const timed = jobs.filter((j) => j.since > 0)
  if (timed.length === 0) return null
  const total = timed.reduce((sum, j) => sum + (nowMs - j.since), 0)
  return age(nowMs - total / timed.length, nowMs)
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}
