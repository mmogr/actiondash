import { describe, expect, it } from 'vitest'
import { forecastBucket, insightFor } from '../src/model/forecast'
import { recordCompleted, type DurationMap } from '../src/model/durations'
import { buildBuckets, type ClassBucket } from '../src/model/queue'
import { PLANS } from '../src/model/plans'
import type { RunWithRepo, WorkflowJob } from '../src/github/types'
import { makeJob, makeRun } from './helpers'

const REPO = { owner: 'acme', name: 'app' }
const NOW = Date.parse('2026-09-09T10:10:00Z')
const MIN = 60_000

function learned(entries: Record<string, number>): DurationMap {
  let map: DurationMap = {}
  let id = 1000
  for (const [name, minutes] of Object.entries(entries)) {
    map = recordCompleted(
      map,
      REPO,
      [
        makeJob({
          id: id++,
          name,
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-09-09T09:00:00Z',
          completed_at: new Date(Date.parse('2026-09-09T09:00:00Z') + minutes * MIN).toISOString(),
        }),
      ],
      NOW,
    )
  }
  return map
}

function index(jobs: WorkflowJob[]): Map<number, WorkflowJob[]> {
  const map = new Map<number, WorkflowJob[]>()
  for (const job of jobs) map.set(job.run_id, [...(map.get(job.run_id) ?? []), job])
  return map
}

function macos(runs: RunWithRepo[], jobs: WorkflowJob[], plan = PLANS.free): ClassBucket {
  return buildBuckets(runs, index(jobs), plan)[0]!
}

function runningJob(id: number, runId: number, name: string, minutesAgo: number) {
  return makeJob({
    id,
    run_id: runId,
    name,
    status: 'in_progress',
    started_at: new Date(NOW - minutesAgo * MIN).toISOString(),
  })
}

function queuedJob(id: number, runId: number, name: string, minutesAgo: number) {
  return makeJob({
    id,
    run_id: runId,
    name,
    status: 'queued',
    created_at: new Date(NOW - minutesAgo * MIN).toISOString(),
  })
}

describe('forecastBucket', () => {
  it('expects a running job to end its usual duration after it started', () => {
    const run = makeRun({ id: 1 })
    const bucket = macos([run], [runningJob(10, 1, 'build', 4)])

    const f = forecastBucket(bucket, learned({ build: 12 }), NOW)

    expect(f.jobs.get(10)?.end).toBe(NOW + 8 * MIN)
    expect(f.jobs.get(10)?.overdue).toBe(false)
    expect(f.nextSlotAt).toBe(NOW)
  })

  it('never forecasts an end in the past, and flags a job past its usual length', () => {
    const run = makeRun({ id: 1 })
    const bucket = macos([run], [runningJob(10, 1, 'build', 20)])

    const f = forecastBucket(bucket, learned({ build: 12 }), NOW)

    expect(f.jobs.get(10)?.end).toBe(NOW + MIN)
    expect(f.jobs.get(10)?.overdue).toBe(true)
  })

  it('gives queued jobs the slot that frees first, in queue order', () => {
    // Five slots, all held. Two queued jobs: the older takes the slot that
    // frees first, the newer the next one.
    const run = makeRun({ id: 1 })
    const jobs = [
      runningJob(11, 1, 'long', 2),
      runningJob(12, 1, 'short', 2),
      runningJob(13, 1, 'long', 1),
      runningJob(14, 1, 'long', 1),
      runningJob(15, 1, 'long', 1),
      queuedJob(20, 1, 'next', 5),
      queuedJob(21, 1, 'next', 4),
    ]
    const bucket = macos([run], jobs)

    const f = forecastBucket(bucket, learned({ long: 20, short: 5, next: 3 }), NOW)

    expect(f.nextSlotAt).toBe(NOW + 3 * MIN)
    expect(f.nextToFinish?.job.id).toBe(12)
    expect(f.jobs.get(20)?.start).toBe(NOW + 3 * MIN)
    expect(f.jobs.get(20)?.end).toBe(NOW + 6 * MIN)
    // The second queued job takes the same slot again once the first is done,
    // since every other slot frees later.
    expect(f.jobs.get(21)?.start).toBe(NOW + 6 * MIN)
    expect(f.jobs.get(21)?.lane).toBe(f.jobs.get(20)?.lane)
    expect(f.queueClearsAt).toBe(NOW + 9 * MIN)
  })

  it('starts a queued job now when a slot is idle', () => {
    const run = makeRun({ id: 1 })
    const bucket = macos([run], [runningJob(11, 1, 'build', 1), queuedJob(20, 1, 'test', 1)])

    const f = forecastBucket(bucket, learned({ build: 10, test: 2 }), NOW)

    expect(f.lanes).toBe(5)
    expect(f.jobs.get(20)?.start).toBe(NOW)
    expect(f.jobs.get(20)?.lane).toBeGreaterThan(0)
  })

  it('guesses from the class when a job has never been seen, and marks the guess', () => {
    const run = makeRun({ id: 1 })
    const bucket = macos([run], [runningJob(11, 1, 'mystery', 1)])

    const f = forecastBucket(bucket, learned({ a: 4, b: 8 }), NOW)

    expect(f.jobs.get(11)?.typical).toBe(6 * 60)
    expect(f.jobs.get(11)?.guessed).toBe(true)
  })

  it('admits it knows nothing before any duration has been learned', () => {
    const run = makeRun({ id: 1 })
    const jobs = [11, 12, 13, 14, 15].map((id) => runningJob(id, 1, 'x', 1))
    jobs.push(queuedJob(20, 1, 'y', 1))
    const bucket = macos([run], jobs)

    const f = forecastBucket(bucket, {}, NOW)

    expect(f.nextSlotAt).toBeNull()
    expect(f.jobs.get(20)?.end).toBeNull()
    expect(f.queueClearsAt).toBeNull()
  })

  it('summarises a run by its first start and last finish', () => {
    const run = makeRun({ id: 1 })
    const jobs = [
      ...[11, 12, 13, 14, 15].map((id) => runningJob(id, 1, 'long', 1)),
      queuedJob(20, 2, 'a', 3),
      queuedJob(21, 2, 'b', 2),
    ]
    const bucket = macos([run, makeRun({ id: 2 })], jobs)

    const f = forecastBucket(bucket, learned({ long: 10, a: 2, b: 30 }), NOW)

    expect(f.runs.get(2)).toEqual({ firstStart: NOW + 9 * MIN, allDone: NOW + 39 * MIN })
  })

  it('leaves out excluded runs, which is how a cancellation is simulated', () => {
    const run = makeRun({ id: 1 })
    const jobs = [
      ...[11, 12, 13, 14, 15].map((id) => runningJob(id, 1, 'long', 1)),
      queuedJob(20, 2, 'a', 3),
    ]
    const bucket = macos([run, makeRun({ id: 2 })], jobs)

    const f = forecastBucket(bucket, learned({ long: 10, a: 2 }), NOW, new Set([1]))

    expect(f.jobs.has(11)).toBe(false)
    expect(f.jobs.get(20)?.start).toBe(NOW)
  })
})

describe('insightFor', () => {
  it('names the superseded run whose cancellation most helps the first real queued job', () => {
    // Five slots held by run 1 (old commit, superseded by run 3). Run 2 is a
    // superseded queued run at the head of the queue; run 3 waits behind it.
    const old = makeRun({ id: 1, run_number: 1, created_at: '2026-09-09T09:50:00Z', head_sha: 'a' })
    const mid = makeRun({ id: 2, run_number: 2, created_at: '2026-09-09T09:55:00Z', head_sha: 'b' })
    const fresh = makeRun({ id: 3, run_number: 3, created_at: '2026-09-09T10:00:00Z', head_sha: 'c' })
    const jobs = [
      ...[11, 12, 13, 14, 15].map((id) => runningJob(id, 1, 'long', 5)),
      queuedJob(20, 2, 'build', 4),
      queuedJob(30, 3, 'build', 2),
    ]
    const bucket = macos([old, mid, fresh], jobs)
    const durations = learned({ long: 15, build: 6 })

    const insight = insightFor(bucket, durations, NOW)

    // All five slots free at once, ten minutes out, so run 3 gets one of them
    // then whether or not run 2 is cancelled. Cancelling run 1 frees them now.
    expect(insight?.run.id).toBe(1)
    expect(insight?.beneficiary.run.id).toBe(3)
    expect(insight?.startsAt).toBe(NOW + 10 * MIN)
    expect(insight?.startsAtIfCancelled).toBe(NOW)
  })

  it('says nothing when no superseded run exists or nothing is waiting', () => {
    const run = makeRun({ id: 1 })
    const bucket = macos([run], [runningJob(11, 1, 'long', 1), queuedJob(20, 1, 'a', 1)])

    expect(insightFor(bucket, learned({ long: 10, a: 1 }), NOW)).toBeNull()
  })

  it('says nothing when the cancellation would not move the beneficiary', () => {
    // A superseded run behind the beneficiary in the queue does not hold it up.
    const old = makeRun({ id: 1, run_number: 1, created_at: '2026-09-09T09:50:00Z', head_sha: 'a' })
    const fresh = makeRun({ id: 2, run_number: 2, created_at: '2026-09-09T10:00:00Z', head_sha: 'b' })
    const bucket = macos([old, fresh], [queuedJob(20, 2, 'a', 4), queuedJob(10, 1, 'a', 2)])

    expect(insightFor(bucket, learned({ a: 5 }), NOW)).toBeNull()
  })
})
