import { describe, expect, it } from 'vitest'
import { buildBuckets, distinctRuns, staleJobs } from '../src/model/queue'
import { PLANS } from '../src/model/plans'
import type { WorkflowJob } from '../src/github/types'
import { makeJob, makeRun } from './helpers'

const FREE = PLANS.free

function index(jobs: WorkflowJob[]): Map<number, WorkflowJob[]> {
  const map = new Map<number, WorkflowJob[]>()
  for (const job of jobs) {
    const list = map.get(job.run_id)
    if (list) list.push(job)
    else map.set(job.run_id, [job])
  }
  return map
}

describe('buildBuckets', () => {
  it('counts a run that arrives twice only once', () => {
    // Eight entries built from four jobs is what told a Pro account, whose
    // macOS ceiling really is five, that it had to be on Enterprise.
    const run = makeRun({ id: 1 })
    const jobs = [10, 11, 12, 13].map((id) =>
      makeJob({ id, run_id: 1, status: 'in_progress', started_at: '2026-09-09T10:01:00Z' }),
    )

    const [macos] = buildBuckets([run, run], index(jobs), FREE)

    expect(macos?.running).toHaveLength(4)
    expect(macos?.running.map((j) => j.job.id)).toEqual([10, 11, 12, 13])
  })

  it('counts a job once when one repository is watched under two spellings', () => {
    // repoKey does not normalise case, so Acme/app and acme/app are two watch
    // entries polled independently, each returning the same run and jobs.
    const run = makeRun({ id: 1, repoOwner: 'acme' })
    const sameRepo = makeRun({ id: 1, repoOwner: 'Acme' })
    const jobs = [10, 11].map((id) =>
      makeJob({ id, run_id: 1, status: 'in_progress', started_at: '2026-09-09T10:01:00Z' }),
    )

    const [macos] = buildBuckets([run, sameRepo], index(jobs), FREE)

    expect(macos?.running).toHaveLength(2)
  })

  it('splits running from queued and applies the plan cap', () => {
    const run = makeRun({ id: 1 })
    const jobs = [
      makeJob({ id: 10, run_id: 1, status: 'in_progress', started_at: '2026-09-09T10:01:00Z' }),
      makeJob({ id: 11, run_id: 1, status: 'queued', created_at: '2026-09-09T10:02:00Z' }),
    ]

    const [macos] = buildBuckets([run], index(jobs), FREE)

    expect(macos?.cls).toBe('macos')
    expect(macos?.cap).toBe(5)
    expect(macos?.running.map((j) => j.job.id)).toEqual([10])
    expect(macos?.queued.map((j) => j.job.id)).toEqual([11])
  })

  it('orders queued jobs oldest first so the index is the queue position', () => {
    const run = makeRun({ id: 1 })
    const jobs = [
      makeJob({ id: 12, run_id: 1, status: 'queued', created_at: '2026-09-09T10:30:00Z' }),
      makeJob({ id: 10, run_id: 1, status: 'queued', created_at: '2026-09-09T10:10:00Z' }),
      makeJob({ id: 11, run_id: 1, status: 'queued', created_at: '2026-09-09T10:20:00Z' }),
    ]

    const [macos] = buildBuckets([run], index(jobs), FREE)

    expect(macos?.queued.map((j) => j.job.id)).toEqual([10, 11, 12])
  })

  it('treats waiting, pending and requested as queued', () => {
    const run = makeRun({ id: 1 })
    const jobs = [
      makeJob({ id: 10, run_id: 1, status: 'waiting' }),
      makeJob({ id: 11, run_id: 1, status: 'pending' }),
      makeJob({ id: 12, run_id: 1, status: 'requested' }),
    ]

    const [macos] = buildBuckets([run], index(jobs), FREE)

    expect(macos?.queued).toHaveLength(3)
  })

  it('drops completed jobs, which hold no slot', () => {
    const run = makeRun({ id: 1 })
    const jobs = [makeJob({ id: 10, run_id: 1, status: 'completed', conclusion: 'success' })]

    const [macos] = buildBuckets([run], index(jobs), FREE)

    expect(macos?.running).toHaveLength(0)
    expect(macos?.queued).toHaveLength(0)
  })

  it('separates runner classes and gives self-hosted no cap', () => {
    const run = makeRun({ id: 1 })
    const jobs = [
      makeJob({ id: 10, run_id: 1, status: 'in_progress', labels: ['macos-14'] }),
      makeJob({ id: 11, run_id: 1, status: 'in_progress', labels: ['ubuntu-latest'] }),
      makeJob({ id: 12, run_id: 1, status: 'in_progress', labels: ['self-hosted', 'macos'] }),
    ]

    const buckets = buildBuckets([run], index(jobs), FREE)
    const byClass = Object.fromEntries(buckets.map((b) => [b.cls, b]))

    expect(byClass.macos?.running).toHaveLength(1)
    expect(byClass.linux?.running).toHaveLength(1)
    expect(byClass.linux?.cap).toBe(20)
    expect(byClass['self-hosted']?.running).toHaveLength(1)
    expect(byClass['self-hosted']?.cap).toBeNull()
  })

  it('always shows the macOS bucket, and only non-empty buckets otherwise', () => {
    const buckets = buildBuckets([], new Map(), FREE)

    expect(buckets.map((b) => b.cls)).toEqual(['macos'])
  })

  it('propagates superseded runs onto their jobs', () => {
    const older = makeRun({ id: 1, run_number: 1, created_at: '2026-09-09T10:00:00Z', head_sha: 'aaa' })
    const newer = makeRun({ id: 2, run_number: 2, created_at: '2026-09-09T10:05:00Z', head_sha: 'bbb' })
    const jobs = [
      makeJob({ id: 10, run_id: 1, status: 'queued' }),
      makeJob({ id: 11, run_id: 2, status: 'queued' }),
    ]

    const buckets = buildBuckets([older, newer], index(jobs), FREE)
    const stale = staleJobs(buckets)

    expect(stale.map((j) => j.job.id)).toEqual([10])
    expect(stale[0]?.supersededBy?.run_number).toBe(2)
  })

  it('skips runs whose jobs have not been fetched', () => {
    const buckets = buildBuckets([makeRun({ id: 1 })], new Map(), FREE)

    expect(buckets[0]?.running).toHaveLength(0)
    expect(buckets[0]?.queued).toHaveLength(0)
  })
})

describe('distinctRuns', () => {
  it('collapses several jobs of one run into a single cancel target', () => {
    const run = makeRun({ id: 1 })
    const jobs = [
      makeJob({ id: 10, run_id: 1, status: 'queued' }),
      makeJob({ id: 11, run_id: 1, status: 'queued' }),
    ]

    const buckets = buildBuckets([run], index(jobs), FREE)
    const targets = distinctRuns(buckets.flatMap((b) => b.queued))

    expect(targets).toHaveLength(1)
    expect(targets[0]?.repo).toEqual({ owner: 'acme', name: 'app' })
  })
})
