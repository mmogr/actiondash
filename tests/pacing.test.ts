import { describe, expect, it } from 'vitest'
import { computeInterval, type PacingInput } from '../src/github/poller'

const NOW = 1_789_000_000_000
const RESET = NOW / 1000 + 3600 // a full hour left in the window

function input(over: Partial<PacingInput> = {}): PacingInput {
  return {
    baseMs: 15_000,
    remaining: 5000,
    resetEpochSec: RESET,
    billedPerPoll: 1,
    retryAfterMs: 0,
    nowMs: NOW,
    ...over,
  }
}

describe('computeInterval', () => {
  it('uses the configured interval when the budget is comfortable', () => {
    // A near-idle dashboard: almost everything answers 304, so a poll is cheap.
    expect(computeInterval(input({ billedPerPoll: 2 }))).toBe(15_000)
  })

  it('stretches past the configured interval when a poll is expensive', () => {
    // 24 requests a poll over a full hour cannot fit in 5,000 at 15 seconds.
    const ms = computeInterval(input({ billedPerPoll: 24, remaining: 5000 }))
    expect(ms).toBeGreaterThan(15_000)

    // The result must actually fit the budget it was derived from.
    const pollsPerHour = 3_600_000 / ms
    expect(pollsPerHour * 24).toBeLessThanOrEqual(5000)
  })

  it('never lets the projected spend exceed the remaining budget', () => {
    const windowMs = 3_600_000
    for (const billed of [1, 5, 24, 60, 200]) {
      for (const remaining of [5000, 2000, 400, 50, 3]) {
        const ms = computeInterval(input({ billedPerPoll: billed, remaining }))
        if (ms >= windowMs) {
          // Waiting for the window to refill. Nothing is spent meanwhile.
          continue
        }
        expect(Math.floor(windowMs / ms) * billed).toBeLessThanOrEqual(remaining)
      }
    }
  })

  it('waits for the refill rather than overspending an exhausted budget', () => {
    const ms = computeInterval(input({ remaining: 0 }))
    expect(ms).toBeGreaterThanOrEqual(3_600_000)
  })

  it('never waits longer than the window reset', () => {
    const ms = computeInterval(input({ remaining: 1, billedPerPoll: 200 }))
    expect(ms).toBeLessThanOrEqual(3_600_000 + 10_000)
  })

  it('obeys retry-after ahead of its own arithmetic', () => {
    expect(computeInterval(input({ retryAfterMs: 60_000 }))).toBe(60_000)
  })

  it('never returns less than the configured interval, even for retry-after', () => {
    expect(computeInterval(input({ baseMs: 30_000, retryAfterMs: 5_000 }))).toBe(30_000)
  })

  it('resumes at the configured interval once the window has refilled', () => {
    // Immediately after a reset the allowance is full and a poll is cheap.
    const ms = computeInterval(input({ remaining: 5000, billedPerPoll: 3 }))
    expect(ms).toBe(15_000)
  })

  it('falls back to the configured interval before any limit is known', () => {
    expect(computeInterval(input({ remaining: null }))).toBe(15_000)
  })

  it('treats a zero cost as one request, so it cannot divide by zero', () => {
    expect(Number.isFinite(computeInterval(input({ billedPerPoll: 0 })))).toBe(true)
  })

  it('paces harder as the reset approaches with little budget left', () => {
    const early = computeInterval(input({ remaining: 200, billedPerPoll: 10 }))
    const late = computeInterval(
      input({ remaining: 200, billedPerPoll: 10, resetEpochSec: NOW / 1000 + 120 }),
    )
    expect(late).toBeLessThan(early)
  })
})
