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

/** Clock time without seconds, for estimates: "22:31". */
export function shortClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** A duration in seconds as "45s", "12m" or "1h 5m". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const minutes = Math.round(s / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rem = minutes % 60
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`
}

/** An estimate relative to now: "in ~3m", "now", or "~2m ago". */
export function relative(ms: number, nowMs: number): string {
  const delta = ms - nowMs
  if (Math.abs(delta) < 45_000) return 'now'
  return delta > 0 ? `in ~${duration(delta / 1000)}` : `~${duration(-delta / 1000)} ago`
}
