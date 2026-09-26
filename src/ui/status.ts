import type { DataHealth } from '../model/health'
import type { PacingReason } from '../model/status'
import { age, duration, shortClock } from './format'

/** Data older than this is shown in red whatever the cadence. */
export const VERY_OLD_MS = 10 * 60_000

export type PillTone = 'live' | 'busy' | 'paced' | 'warn' | 'bad' | 'off'

export interface Pill {
  tone: PillTone
  label: string
  /** The longer explanation, for the tooltip and screen readers. */
  detail: string
}

export interface PillInput {
  nowMs: number
  health: DataHealth
  polling: boolean
  lastPoll: number | null
  nextPollAt: number | null
  /** The interval actually in use, which pacing may have stretched. */
  intervalMs: number
  pacing: PacingReason
  /** When the allowance refills, in epoch ms, while it is used up. */
  limitedUntilMs: number | null
}

function countdown(nextPollAt: number | null, nowMs: number): string {
  if (nextPollAt === null) return ''
  const s = Math.max(0, Math.round((nextPollAt - nowMs) / 1000))
  return s < 60 ? `${s}s` : duration(s)
}

const PACING_TEXT: Record<Exclude<PacingReason, 'floor'>, string> = {
  budget: 'Paced to stay inside the hourly request allowance.',
  'retry-after': 'GitHub asked for a pause.',
  refill: 'Waiting for the hourly request allowance to refill.',
}

/**
 * The one line that says whether the page can be trusted right now, and why
 * not when it cannot. Checked in order of what the reader most needs to know.
 */
export function pillFor(i: PillInput): Pill {
  if (i.health === 'offline') {
    return { tone: 'off', label: 'Offline', detail: 'Checking again when this device is back online.' }
  }
  if (i.health === 'limited' && i.limitedUntilMs !== null) {
    const at = shortClock(i.limitedUntilMs)
    return {
      tone: 'bad',
      label: `Paused until ${at}`,
      detail: `The hourly request allowance is used up. It refills at ${at}.`,
    }
  }
  if (i.polling) return { tone: 'busy', label: 'Checking…', detail: 'Asking GitHub now.' }
  if (i.health === 'unreachable') {
    return { tone: 'bad', label: "Can't reach GitHub", detail: 'No repository answered the last check.' }
  }
  if (i.lastPoll === null) return { tone: 'busy', label: 'Starting…', detail: 'The first check has not finished.' }

  const staleFor = i.nowMs - i.lastPoll
  const updated = `Updated ${age(i.lastPoll, i.nowMs)} ago.`
  const next = countdown(i.nextPollAt, i.nowMs)
  const nextText = next ? ` Next check in ${next}.` : ''
  if (staleFor > VERY_OLD_MS) {
    return { tone: 'bad', label: `Data ${age(i.lastPoll, i.nowMs)} old`, detail: `${updated}${nextText}` }
  }
  if (staleFor > Math.max(2 * i.intervalMs, 60_000)) {
    return { tone: 'warn', label: `Data ${age(i.lastPoll, i.nowMs)} old`, detail: `${updated}${nextText}` }
  }
  if (i.pacing !== 'floor') {
    return {
      tone: 'paced',
      label: next ? `Paced · next ${next}` : 'Paced',
      detail: `${PACING_TEXT[i.pacing]} ${updated}${nextText}`,
    }
  }
  return { tone: 'live', label: next ? `Live · next ${next}` : 'Live', detail: `${updated}${nextText}` }
}
