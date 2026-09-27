import { describe, expect, it } from 'vitest'
import type { MyRun } from '../src/model/mine'
import type { ClassBucket } from '../src/model/queue'
import { titleFor } from '../src/ui/title'
import { makeJob, makeRun } from './helpers'

const T0 = Date.parse('2026-09-21T10:00:00Z')

function my(over: Partial<MyRun>): MyRun {
  return {
    run: makeRun({ id: 214, run_number: 214 }),
    state: 'queued',
    stale: false,
    startsAt: null,
    doneAt: null,
    basis: 'learned',
    since: T0,
    position: null,
    failed: [],
    ...over,
  }
}

const pool: ClassBucket = { cls: 'macos', cap: 5, running: [], queued: [] }

describe('titleFor', () => {
  it('says why nothing can be trusted before anything else', () => {
    expect(titleFor({ health: 'offline', mine: [my({})], headline: pool })).toMatch(/^Offline/)
    expect(titleFor({ health: 'limited', mine: [], headline: pool })).toMatch(/^Paused/)
    expect(titleFor({ health: 'unreachable', mine: [], headline: pool })).toMatch(/^Can't check/)
  })

  it('claims nothing about the pool before the first check has finished', () => {
    // An empty pool before any answer reads exactly like an idle one.
    expect(titleFor({ health: 'none', mine: [], headline: pool })).toBe('actiondash')
    expect(titleFor({ health: 'none', mine: [my({ state: 'running' })], headline: pool })).toBe('actiondash')
  })

  it('names a failed job without calling the run failed', () => {
    const failing = my({ state: 'running', failed: [makeJob({ name: 'test-ui' })] })

    expect(titleFor({ health: 'ok', mine: [my({}), failing], headline: pool })).toMatch(/^#214 job failed/)
  })

  it('gives the reader’s own run first', () => {
    expect(titleFor({ health: 'ok', mine: [my({ startsAt: T0 })], headline: pool })).toMatch(/^#214 starts ~/)
    expect(titleFor({ health: 'ok', mine: [my({ state: 'running', doneAt: T0 })], headline: pool })).toMatch(
      /^#214 done ~/,
    )
  })

  it('falls back to the scarce pool', () => {
    expect(titleFor({ health: 'ok', mine: [], headline: pool })).toBe('0/5 macOS · 0 queued')
    expect(titleFor({ health: 'ok', mine: [], headline: undefined })).toBe('actiondash')
  })

  it('names the unchecked repositories before a partly checked pool', () => {
    // Otherwise an idle pool with a repository missing reads as a fully checked one.
    expect(titleFor({ health: 'partial', unchecked: 1, mine: [], headline: pool })).toBe(
      '1 unchecked · 0/5 macOS · 0 queued',
    )
  })

  it('leaves the unchecked count out of the reader’s own run, and out of a fully checked pool', () => {
    expect(titleFor({ health: 'partial', unchecked: 1, mine: [my({})], headline: pool })).toBe(
      '#214 waiting · actiondash',
    )
    expect(titleFor({ health: 'ok', unchecked: 1, mine: [], headline: pool })).toBe('0/5 macOS · 0 queued')
  })
})
