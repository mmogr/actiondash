import { describe, expect, it } from 'vitest'
import {
  atCapacityMs,
  dayKey,
  EMPTY_HISTORY,
  gaps,
  KEEP_DAYS,
  MAX_SAMPLES,
  record,
  recordedPools,
  repoShare,
  sanitiseHistory,
  slice,
  type HistoryState,
} from '../src/model/history'
import { projectedRemaining } from '../src/model/budget'
import type { ClassBucket, DashJob } from '../src/model/queue'
import { makeJob, makeRun } from './helpers'

const T0 = Date.parse('2026-09-09T10:00:00Z')
const INTERVAL = 15_000

function job(repoName: string, id: number): DashJob {
  const run = makeRun({ id, repoName })
  return {
    job: makeJob({ id: id * 10, run_id: id, status: 'in_progress' }),
    run,
    repo: { owner: 'acme', name: repoName },
    cls: 'macos',
    supersededBy: null,
    since: T0,
  }
}

function macos(running: DashJob[], queued: DashJob[] = []): ClassBucket[] {
  return [{ cls: 'macos', cap: 5, running, queued }]
}

function poll(state: HistoryState, buckets: ClassBucket[], at: number): HistoryState {
  return record(state, buckets, at, INTERVAL)
}

describe('record', () => {
  it('collapses polls that read the same into one sample', () => {
    const b = macos([job('app', 1)])
    let s = poll(EMPTY_HISTORY, b, T0)
    s = poll(s, b, T0 + INTERVAL)
    s = poll(s, b, T0 + 2 * INTERVAL)

    expect(s.samples).toHaveLength(1)
    expect(s.samples[0]).toMatchObject({ t: T0, until: T0 + 2 * INTERVAL, inUse: { macos: 1 } })
  })

  it('starts a new sample when the reading changes', () => {
    let s = poll(EMPTY_HISTORY, macos([job('app', 1)]), T0)
    s = poll(s, macos([job('app', 1)], [job('app', 2)]), T0 + INTERVAL)

    expect(s.samples).toHaveLength(2)
    expect(s.samples[1]?.queued).toEqual({ macos: 1 })
  })

  it('marks a gap after a silence, so a closed tab is not drawn as a plateau', () => {
    const b = macos([job('app', 1)])
    let s = poll(EMPTY_HISTORY, b, T0)
    s = poll(s, b, T0 + 10 * 60_000)

    expect(s.samples).toHaveLength(2)
    expect(s.samples[0]?.gap).toBe(true)
    expect(gaps(s.samples)).toEqual([[T0, T0 + 10 * 60_000]])
  })

  it('does not mistake a slow but regular poll for a gap', () => {
    // Pacing can stretch the interval to a minute; three of those is silence.
    const b = macos([job('app', 1)])
    let s = record(EMPTY_HISTORY, b, T0, 60_000)
    s = record(s, b, T0 + 170_000, 60_000)

    expect(s.samples).toHaveLength(1)
    expect(s.samples[0]?.gap).toBeUndefined()
  })

  it('credits slot time to the repositories running, per day', () => {
    let s = poll(EMPTY_HISTORY, macos([job('app', 1), job('app', 2), job('site', 3)]), T0)
    s = poll(s, macos([job('app', 1), job('app', 2), job('site', 3)]), T0 + INTERVAL)
    s = poll(s, macos([job('site', 3)]), T0 + 2 * INTERVAL)

    expect(repoShare(s, dayKey(T0), 'macos')).toEqual([
      { repo: 'acme/app', seconds: 30 },
      { repo: 'acme/site', seconds: 30 },
    ])
  })

  it('credits nothing across a gap, since nobody watched', () => {
    let s = poll(EMPTY_HISTORY, macos([job('app', 1)]), T0)
    s = poll(s, macos([job('app', 1)]), T0 + 60 * 60_000)

    expect(repoShare(s, dayKey(T0), 'macos')).toEqual([])
  })

  it('forgets samples and days older than the retention window', () => {
    let s = poll(EMPTY_HISTORY, macos([job('app', 1)]), T0)
    s = poll(s, macos([job('app', 1)]), T0 + INTERVAL)
    const later = T0 + (KEEP_DAYS + 1) * 86_400_000
    s = poll(s, macos([]), later)

    expect(s.samples.map((x) => x.t)).toEqual([later])
    expect(Object.keys(s.days)).toEqual([])
  })

  it('keeps the newest samples once the cap is reached', () => {
    let s = EMPTY_HISTORY
    for (let i = 0; i < MAX_SAMPLES + 5; i++) {
      s = poll(s, macos(i % 2 === 0 ? [job('app', 1)] : []), T0 + i * INTERVAL)
    }

    expect(s.samples).toHaveLength(MAX_SAMPLES)
    expect(s.samples[s.samples.length - 1]?.t).toBe(T0 + (MAX_SAMPLES + 4) * INTERVAL)
  })
})

describe('selectors', () => {
  it('slices to a window, clipping the samples at its edges', () => {
    let s = EMPTY_HISTORY
    for (let i = 0; i <= 10; i++) s = poll(s, macos([job('app', 1)]), T0 + i * INTERVAL)

    const window = slice(s, T0 + 2 * INTERVAL, T0 + 4 * INTERVAL)

    expect(window).toHaveLength(1)
    expect(window[0]).toMatchObject({ t: T0 + 2 * INTERVAL, until: T0 + 4 * INTERVAL })
    expect(slice(s, T0 + 20 * INTERVAL, T0 + 30 * INTERVAL)).toEqual([])
  })

  it('totals the time a class spent at its ceiling', () => {
    const five = [1, 2, 3, 4, 5].map((i) => job('app', i))
    let s = poll(EMPTY_HISTORY, macos(five), T0)
    s = poll(s, macos(five), T0 + 4 * INTERVAL)
    s = poll(s, macos(five.slice(0, 2)), T0 + 5 * INTERVAL)
    s = poll(s, macos(five.slice(0, 2)), T0 + 9 * INTERVAL)

    expect(atCapacityMs(s.samples, 'macos', 5)).toBe(4 * INTERVAL)
  })

  it('lists the pools anything was recorded in, in the usual order', () => {
    const state: HistoryState = {
      samples: [
        { t: 1, until: 2, inUse: { linux: 3 }, queued: {} },
        { t: 3, until: 4, inUse: {}, queued: { macos: 2, windows: 0 } },
      ],
      days: {},
    }

    expect(recordedPools(state)).toEqual(['macos', 'linux'])
    expect(recordedPools(EMPTY_HISTORY)).toEqual([])
  })
})

describe('sanitiseHistory', () => {
  it('drops malformed samples and days, keeping the rest', () => {
    const state = sanitiseHistory({
      samples: [
        { t: 1, until: 2, inUse: { macos: 1 }, queued: {}, gap: true },
        { t: 5, until: 4, inUse: {}, queued: {} },
        { t: 'x', until: 2, inUse: {}, queued: {} },
      ],
      days: { '2026-09-09': { 'acme/app': { macos: 30 } }, junk: {}, '2026-09-08': { bad: { macos: 'x' } } },
    })

    expect(state.samples).toEqual([{ t: 1, until: 2, inUse: { macos: 1 }, queued: {}, gap: true }])
    expect(state.days).toEqual({ '2026-09-09': { 'acme/app': { macos: 30 } }, '2026-09-08': {} })
  })

  it('treats anything unexpected as empty', () => {
    expect(sanitiseHistory(null)).toEqual(EMPTY_HISTORY)
    expect(sanitiseHistory([])).toEqual(EMPTY_HISTORY)
  })
})

describe('projectedRemaining', () => {
  it('spends the hourly cost pro rata until the reset, and never goes negative', () => {
    expect(projectedRemaining(4321, 720, 1_800_000)).toBe(3961)
    expect(projectedRemaining(100, 5000, 3_600_000)).toBe(0)
    expect(projectedRemaining(4321, 720, 0)).toBe(4321)
  })
})
