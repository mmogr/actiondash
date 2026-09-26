import { describe, expect, it } from 'vitest'
import { MIN_MANUAL_GAP_MS, refreshBlock } from '../src/model/status'
import { pillFor, VERY_OLD_MS, type PillInput } from '../src/ui/status'

const T0 = Date.parse('2026-09-21T10:00:00Z')

describe('refreshBlock', () => {
  const idle = {
    online: true,
    limited: false,
    polling: false,
    pacing: 'floor' as const,
    lastStartedAt: T0 - MIN_MANUAL_GAP_MS,
    nowMs: T0,
  }

  it('allows a refresh once the fastest interval has passed', () => {
    expect(refreshBlock(idle)).toBeNull()
    expect(refreshBlock({ ...idle, lastStartedAt: T0 - MIN_MANUAL_GAP_MS + 100 })).toBe('too-soon')
  })

  it('refuses whenever the pacer is holding back, so asking never spends more than waiting', () => {
    expect(refreshBlock({ ...idle, pacing: 'budget' })).toBe('paced')
    expect(refreshBlock({ ...idle, pacing: 'refill' })).toBe('paced')
    expect(refreshBlock({ ...idle, limited: true })).toBe('limited')
    expect(refreshBlock({ ...idle, online: false })).toBe('offline')
    expect(refreshBlock({ ...idle, polling: true })).toBe('in-flight')
  })
})

describe('pillFor', () => {
  const live: PillInput = {
    nowMs: T0,
    health: 'ok',
    polling: false,
    lastPoll: T0 - 6_000,
    nextPollAt: T0 + 9_000,
    intervalMs: 15_000,
    pacing: 'floor',
    limitedUntilMs: null,
  }

  it('says live, with the countdown to the next check', () => {
    expect(pillFor(live)).toMatchObject({ tone: 'live', label: 'Live · next 9s' })
  })

  it('says paced, and why, when the interval has been stretched', () => {
    const pill = pillFor({ ...live, pacing: 'budget', nextPollAt: T0 + 38_000, intervalMs: 40_000 })
    expect(pill).toMatchObject({ tone: 'paced', label: 'Paced · next 38s' })
    expect(pill.detail).toContain('hourly request allowance')
  })

  it('warns once the data is older than the cadence explains', () => {
    const late = { ...live, lastPoll: T0 - 3 * 60_000 }
    expect(pillFor(late)).toMatchObject({ tone: 'warn', label: 'Data 3m old' })
    // A slow cadence the pacer chose is not staleness.
    expect(pillFor({ ...late, intervalMs: 5 * 60_000 }).tone).toBe('live')
    expect(pillFor({ ...live, lastPoll: T0 - VERY_OLD_MS - 60_000 }).tone).toBe('bad')
  })

  it('puts offline, the allowance and an unreachable GitHub ahead of freshness', () => {
    expect(pillFor({ ...live, health: 'offline' }).label).toBe('Offline')
    expect(pillFor({ ...live, health: 'limited', limitedUntilMs: T0 + 600_000 }).label).toMatch(
      /^Paused until /,
    )
    expect(pillFor({ ...live, health: 'unreachable' }).label).toBe("Can't reach GitHub")
    expect(pillFor({ ...live, polling: true }).label).toBe('Checking…')
  })
})
