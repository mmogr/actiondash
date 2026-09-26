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
})
