import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  durationKey,
  fallbackSeconds,
  KEEP,
  MAX_KEYS,
  rangeSeconds,
  recordCompleted,
  sanitiseDurations,
  typicalSeconds,
  type DurationMap,
} from '../src/model/durations'
import { makeJob } from './helpers'

const REPO = { owner: 'acme', name: 'app' }
const NOW = 1_789_000_000_000

function done(id: number, name: string, minutes: number) {
  return makeJob({
    id,
    name,
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-09-09T10:00:00Z',
    completed_at: new Date(Date.parse('2026-09-09T10:00:00Z') + minutes * 60_000).toISOString(),
  })
}

describe('recordCompleted', () => {
  it('learns a completed job and answers its typical duration', () => {
    const map = recordCompleted({}, REPO, [done(1, 'build', 12)], NOW)

    expect(typicalSeconds(map, durationKey(REPO, 'build'))).toBe(720)
  })

  it('returns the same map when nothing new was seen, so storage is not rewritten', () => {
    // Completed jobs stay in every poll of an active run; counting them again
    // each time would turn one long run into ten.
    const once = recordCompleted({}, REPO, [done(1, 'build', 12)], NOW)
    const twice = recordCompleted(once, REPO, [done(1, 'build', 12)], NOW + 1)

    expect(twice).toBe(once)
    expect(twice[durationKey(REPO, 'build')]?.secs).toEqual([720])
  })

  it('ignores jobs still running, cancelled ones, and ones without timestamps', () => {
    const jobs = [
      makeJob({ id: 1, status: 'in_progress', started_at: '2026-09-09T10:00:00Z' }),
      { ...done(2, 'build', 3), conclusion: 'cancelled' },
      { ...done(3, 'build', 3), started_at: null },
    ]

    expect(recordCompleted({}, REPO, jobs, NOW)).toEqual({})
  })

  it('keeps only the most recent runs of a job', () => {
    let map: DurationMap = {}
    for (let i = 1; i <= KEEP + 3; i++) map = recordCompleted(map, REPO, [done(i, 'build', i)], NOW)

    const record = map[durationKey(REPO, 'build')]
    expect(record?.secs).toHaveLength(KEEP)
    expect(record?.secs[0]).toBe(4 * 60)
    expect(record?.ids[0]).toBe(4)
  })

  it('forgets the job names seen longest ago once the map is full', () => {
    let map: DurationMap = {}
    for (let i = 0; i <= MAX_KEYS; i++) {
      map = recordCompleted(map, REPO, [done(i, `job-${i}`, 1)], NOW + i)
    }

    expect(Object.keys(map)).toHaveLength(MAX_KEYS)
    expect(map[durationKey(REPO, 'job-0')]).toBeUndefined()
    expect(map[durationKey(REPO, `job-${MAX_KEYS}`)]).toBeDefined()
  })

  it('keeps the same job name apart across repositories', () => {
    const other = { owner: 'acme', name: 'site' }
    let map = recordCompleted({}, REPO, [done(1, 'build', 10)], NOW)
    map = recordCompleted(map, other, [done(2, 'build', 2)], NOW)

    expect(typicalSeconds(map, durationKey(REPO, 'build'))).toBe(600)
    expect(typicalSeconds(map, durationKey(other, 'build'))).toBe(120)
  })
})

describe('typical, range and fallback', () => {
  it('answers the median and the spread', () => {
    let map: DurationMap = {}
    for (const [id, m] of [
      [1, 11],
      [2, 13],
      [3, 12],
      [4, 30],
    ] as const) {
      map = recordCompleted(map, REPO, [done(id, 'build', m)], NOW)
    }
    const key = durationKey(REPO, 'build')

    expect(typicalSeconds(map, key)).toBe(12.5 * 60)
    expect(rangeSeconds(map, key)).toEqual([11 * 60, 30 * 60])
    expect(typicalSeconds(map, 'nope')).toBeUndefined()
  })

  it('falls back to the class median for a job never seen', () => {
    let map = recordCompleted({}, REPO, [done(1, 'a', 4)], NOW)
    map = recordCompleted(map, REPO, [done(2, 'b', 8)], NOW)
    map = recordCompleted(map, REPO, [{ ...done(3, 'lin', 60), labels: ['ubuntu-latest'] }], NOW)

    expect(fallbackSeconds(map, 'macos')).toBe(6 * 60)
    expect(fallbackSeconds(map, 'linux')).toBe(60 * 60)
    expect(fallbackSeconds(map, 'windows')).toBeUndefined()
  })
})

describe('sanitiseDurations', () => {
  it('drops entries that are not the expected shape', () => {
    const map = sanitiseDurations({
      good: { secs: [1, 2], ids: [1, 2], cls: 'macos', seenAt: 5 },
      mismatch: { secs: [1], ids: [], cls: 'macos', seenAt: 5 },
      junk: 'no',
    })

    expect(Object.keys(map)).toEqual(['good'])
  })

  it('accepts anything that is not an object as empty', () => {
    expect(sanitiseDurations(null)).toEqual({})
    expect(sanitiseDurations('x')).toEqual({})
  })
})

describe('persisted durations', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('round-trips through storage and clears on forget', async () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
    vi.resetModules()
    const first = await import('../src/state/durations')
    first.learnDurations(REPO, [done(1, 'build', 5)], NOW)
    expect(store.has(first.DURATIONS_KEY)).toBe(true)

    vi.resetModules()
    const second = await import('../src/state/durations')
    expect(typicalSeconds(second.durations.value, durationKey(REPO, 'build'))).toBe(300)

    second.clearDurations()
    expect(store.has(second.DURATIONS_KEY)).toBe(false)
    expect(second.durations.value).toEqual({})
  })
})
