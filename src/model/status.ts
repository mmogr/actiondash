/**
 * When a refresh on demand is allowed. A manual refresh must never spend what
 * the pacer is saving, so it is refused whenever the pacer is holding back,
 * and never offered faster than the fastest interval a reader can pick.
 */

/** Why the next poll is as far away as it is. */
export type PacingReason =
  /** The configured interval: nothing is holding the dashboard back. */
  | 'floor'
  /** Stretched so the hourly allowance lasts until it refills. */
  | 'budget'
  /** GitHub asked for a pause. */
  | 'retry-after'
  /** Nothing left to spend: waiting for the allowance to refill. */
  | 'refill'

export type RefreshBlock = 'offline' | 'limited' | 'in-flight' | 'paced' | 'too-soon'

/** The fastest refresh interval on offer, and so the fastest manual refresh. */
export const MIN_MANUAL_GAP_MS = 10_000

export function refreshBlock(input: {
  online: boolean
  limited: boolean
  polling: boolean
  pacing: PacingReason
  lastStartedAt: number | null
  nowMs: number
}): RefreshBlock | null {
  if (!input.online) return 'offline'
  if (input.limited) return 'limited'
  if (input.polling) return 'in-flight'
  if (input.pacing !== 'floor') return 'paced'
  if (input.lastStartedAt !== null && input.nowMs - input.lastStartedAt < MIN_MANUAL_GAP_MS) {
    return 'too-soon'
  }
  return null
}

export function refreshBlockText(block: RefreshBlock): string {
  switch (block) {
    case 'offline':
      return 'This device is offline.'
    case 'limited':
      return 'The hourly request allowance is used up.'
    case 'in-flight':
      return 'Already checking.'
    case 'paced':
      return 'Paced to stay inside the hourly request allowance.'
    case 'too-soon':
      return 'Checked moments ago.'
  }
}
