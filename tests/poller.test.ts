import { describe, expect, it } from 'vitest'
import { CONFIRMING_POLLS, mergeRunLists, promoteObserved } from '../src/github/poller'
import { makeRun } from './helpers'

describe('mergeRunLists', () => {
  it('keeps a run that appears in both listings only once', () => {
    // The two listings are separate requests, so a run that changes status
    // between them can be returned by both. Concatenating them would count
    // every running job of that run twice.
    const run = makeRun({ id: 1, status: 'in_progress' })

    const merged = mergeRunLists([run], [run], 60)

    expect(merged).toHaveLength(1)
    expect(merged[0]?.id).toBe(1)
  })

  it('prefers the in_progress copy, which carries the fresher timestamp', () => {
    // The job cache decides whether to refetch by comparing updated_at, so the
    // staler of the two copies would suppress a refetch that is due.
    const stale = makeRun({ id: 1, updated_at: '2026-09-09T10:00:00Z' })
    const fresh = makeRun({ id: 1, updated_at: '2026-09-09T10:05:00Z' })

    const merged = mergeRunLists([stale], [fresh], 60)

    expect(merged).toHaveLength(1)
    expect(merged[0]?.updated_at).toBe('2026-09-09T10:05:00Z')
  })

  it('lists running runs before queued ones, so the cap truncates the tail', () => {
    const queued = [makeRun({ id: 1 }), makeRun({ id: 2 })]
    const running = [makeRun({ id: 3 }), makeRun({ id: 4 })]

    const merged = mergeRunLists(queued, running, 3)

    expect(merged.map((r) => r.id)).toEqual([3, 4, 1])
  })

  it('passes disjoint listings through unchanged', () => {
    const queued = [makeRun({ id: 1 })]
    const running = [makeRun({ id: 2 })]

    expect(mergeRunLists(queued, running, 60).map((r) => r.id)).toEqual([2, 1])
  })
})

describe('promoteObserved', () => {
  it('refuses a single spike', () => {
    // The whole complaint: one inflated reading became a permanent claim that a
    // Pro account, capped at five macOS jobs, must be on Enterprise.
    const next = promoteObserved([{ macos: 8 }, { macos: 4 }, { macos: 4 }], {})

    expect(next?.macos).toBe(4)
  })

  it('promotes a reading that every poll in the window supports', () => {
    const next = promoteObserved([{ macos: 5 }, { macos: 5 }, { macos: 6 }], { macos: 3 })

    expect(next?.macos).toBe(5)
  })

  it('returns null when nothing beats the stored mark', () => {
    expect(promoteObserved([{ macos: 4 }, { macos: 4 }, { macos: 4 }], { macos: 5 })).toBeNull()
  })

  it('treats each class independently', () => {
    const samples = [
      { macos: 5, linux: 12 },
      { macos: 5, linux: 3 },
      { macos: 5, linux: 12 },
    ]

    const next = promoteObserved(samples, {})

    expect(next?.macos).toBe(5)
    // Linux never held twelve for the whole window, so only three is supported.
    expect(next?.linux).toBe(3)
  })

  it('supports nothing from an empty window', () => {
    expect(promoteObserved([], { macos: 2 })).toBeNull()
  })

  it('needs more than one poll before anything is believed', () => {
    expect(CONFIRMING_POLLS).toBeGreaterThan(1)
  })
})
