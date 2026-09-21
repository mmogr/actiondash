import { describe, expect, it } from 'vitest'
import { mergeRunLists } from '../src/github/poller'
import { makeRun } from './helpers'

describe('mergeRunLists', () => {
  it('keeps a run that appears in both listings only once', () => {
    // GitHub's status filter matches a run's check runs, which are its jobs, so
    // a run with one job running and another queued is returned by both calls.
    // Concatenating them counted every running job of that run twice, which is
    // what told a Pro account it must be on Enterprise.
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
