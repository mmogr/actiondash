import { describe, expect, it } from 'vitest'
import type { RunWithRepo, WorkflowJob } from '../src/github/types'
import type { BucketForecast } from '../src/model/forecast'
import { isMine, myRuns } from '../src/model/mine'
import type { ClassBucket, DashJob } from '../src/model/queue'
import { makeJob, makeRun } from './helpers'

const T0 = Date.parse('2026-09-21T10:00:00Z')
const ME = 'dana-k'

function run(id: number, login: string): RunWithRepo {
  return makeRun({ id, actor: { login } })
}

function dash(job: WorkflowJob, r: RunWithRepo, since = T0): DashJob {
  return {
    job,
    run: r,
    repo: { owner: r.repoOwner, name: r.repoName },
    cls: 'macos',
    supersededBy: null,
    since,
  }
}

function forecasts(runs: Record<number, { firstStart: number | null; allDone: number | null }>) {
  const forecast: BucketForecast = {
    lanes: 5,
    jobs: new Map(),
    runs: new Map(Object.entries(runs).map(([id, f]) => [Number(id), f])),
    nextSlotAt: null,
    nextToFinish: null,
    queueClearsAt: null,
  }
  return new Map([['macos', { forecast }]])
}

describe('isMine', () => {
  it('matches the actor or whoever set the run going, ignoring case', () => {
    expect(isMine(run(1, 'Dana-K'), ME)).toBe(true)
    expect(isMine(makeRun({ id: 2, actor: { login: 'sam' }, triggering_actor: { login: ME } }), ME)).toBe(true)
    expect(isMine(run(3, 'sam'), ME)).toBe(false)
    expect(isMine(run(4, ME), null)).toBe(false)
  })
})

describe('myRuns', () => {
  const theirs = run(1, 'sam')
  const mineRunning = run(2, ME)
  const mineQueued = run(3, ME)
  const bucket: ClassBucket = {
    cls: 'macos',
    cap: 5,
    running: [dash(makeJob({ id: 20, run_id: 2, status: 'in_progress' }), mineRunning, T0 - 10 * 60_000)],
    queued: [
      dash(makeJob({ id: 10, run_id: 1 }), theirs),
      dash(makeJob({ id: 11, run_id: 1 }), theirs),
      dash(makeJob({ id: 30, run_id: 3 }), mineQueued, T0 - 4 * 60_000),
      dash(makeJob({ id: 31, run_id: 3 }), mineQueued),
      dash(makeJob({ id: 12, run_id: 4 }), run(4, 'sam')),
    ],
  }
  const jobsByRun = new Map<number, WorkflowJob[]>([
    [2, [makeJob({ id: 20, run_id: 2, status: 'in_progress' }), makeJob({ id: 21, status: 'completed', conclusion: 'failure' })]],
  ])

  it('lists only the reader’s runs, running first, then by place in line', () => {
    const mine = myRuns([bucket], forecasts({ 2: { firstStart: null, allDone: T0 + 20 * 60_000 }, 3: { firstStart: T0 + 6 * 60_000, allDone: null } }), jobsByRun, ME)

    expect(mine.map((m) => [m.run.id, m.state])).toEqual([
      [2, 'running'],
      [3, 'queued'],
    ])
    expect(mine[0]).toMatchObject({ doneAt: T0 + 20 * 60_000, since: T0 - 10 * 60_000, position: null })
    expect(mine[0]!.failed.map((j) => j.id)).toEqual([21])
    expect(mine[1]).toMatchObject({ startsAt: T0 + 6 * 60_000, doneAt: null, since: T0 - 4 * 60_000 })
  })

  it('says where a waiting run stands, and which run is just ahead of it', () => {
    const [, queued] = myRuns([bucket], forecasts({}), new Map(), ME)

    expect(queued!.position).toMatchObject({ at: 3, of: 5, cls: 'macos' })
    expect(queued!.position!.behind?.id).toBe(1)
  })

  it('says a run is next in line when nothing else is ahead of it', () => {
    const solo: ClassBucket = { cls: 'macos', cap: 5, running: [], queued: [dash(makeJob({ id: 30, run_id: 3 }), mineQueued)] }

    expect(myRuns([solo], forecasts({}), new Map(), ME)[0]!.position).toMatchObject({ at: 1, behind: null })
  })

  it('knows nothing of anyone’s runs without a login', () => {
    expect(myRuns([bucket], forecasts({}), jobsByRun, null)).toEqual([])
  })
})
