import { describe, expect, it } from 'vitest'
import {
  addFinished,
  CANCEL_REQUEST_TTL_MS,
  classifyFinished,
  FINISHED_MAX_AGE_MS,
  isCancelRequested,
  KEEP_FINISHED,
  type FinishedRun,
} from '../src/model/finished'
import { makeJob, makeRun } from './helpers'

const T0 = Date.parse('2026-09-21T10:00:00Z')

const done = (id: number, conclusion: string) =>
  makeJob({ id, name: `job${id}`, status: 'completed', conclusion })

function entry(id: number, at = T0): FinishedRun {
  return {
    run: makeRun({ id }),
    outcome: 'succeeded',
    failedJobs: [],
    at,
    cancelledHere: false,
    rerunAsked: false,
  }
}

describe('classifyFinished', () => {
  it('names the jobs that failed or timed out', () => {
    const result = classifyFinished([done(1, 'success'), done(2, 'failure'), done(3, 'timed_out')])

    expect(result.outcome).toBe('failed')
    expect(result.failed.map((j) => j.id)).toEqual([2, 3])
  })

  it('tells a cancel from a pass', () => {
    expect(classifyFinished([done(1, 'success'), done(2, 'cancelled')]).outcome).toBe('cancelled')
    expect(classifyFinished([done(1, 'success'), done(2, 'skipped')]).outcome).toBe('succeeded')
  })

  it('says a run left unfinished when its jobs had not all finished', () => {
    expect(classifyFinished([done(1, 'success'), makeJob({ id: 2, status: 'waiting' })]).outcome).toBe('left')
  })

  it('does not guess when there is nothing to tell by', () => {
    expect(classifyFinished(null).outcome).toBe('unknown')
    expect(classifyFinished([]).outcome).toBe('unknown')
  })
})

describe('addFinished', () => {
  it('puts the newest first, once per run', () => {
    const list = addFinished([entry(1), entry(2)], [{ ...entry(2), outcome: 'failed' }], new Set(), T0)

    expect(list.map((f) => [f.run.id, f.outcome])).toEqual([
      [2, 'failed'],
      [1, 'succeeded'],
    ])
  })

  it('drops a run that is active again, as a re-run is', () => {
    expect(addFinished([entry(1), entry(2)], [], new Set([1]), T0).map((f) => f.run.id)).toEqual([2])
  })

  it('keeps an hour at most, and a bounded number', () => {
    expect(addFinished([entry(1, T0 - FINISHED_MAX_AGE_MS - 1)], [], new Set(), T0)).toEqual([])
    const many = Array.from({ length: KEEP_FINISHED + 5 }, (_, i) => entry(i + 1))
    expect(addFinished([], many, new Set(), T0)).toHaveLength(KEEP_FINISHED)
  })
})

describe('isCancelRequested', () => {
  it('holds for a while, then lets the button come back', () => {
    const requested = new Map([[1, T0]])

    expect(isCancelRequested(requested, 1, T0 + CANCEL_REQUEST_TTL_MS - 1)).toBe(true)
    expect(isCancelRequested(requested, 1, T0 + CANCEL_REQUEST_TTL_MS)).toBe(false)
    expect(isCancelRequested(requested, 2, T0)).toBe(false)
  })
})
