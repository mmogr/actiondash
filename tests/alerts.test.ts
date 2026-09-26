import { describe, expect, it } from 'vitest'
import { alertsFor, NO_ALERTS } from '../src/model/alerts'
import type { FinishedRun } from '../src/model/finished'
import type { ClassBucket, DashJob } from '../src/model/queue'
import { makeJob, makeRun } from './helpers'

const ALL = { myStarted: true, myFinished: true, slotFreed: true, jobStarted: true, superseded: true }

function job(id: number, runId: number, over: Partial<DashJob> = {}): DashJob {
  const run = makeRun({ id: runId, run_number: runId })
  return {
    job: makeJob({ id, run_id: runId, name: `job-${id}` }),
    run,
    repo: { owner: 'acme', name: 'app' },
    cls: 'macos',
    supersededBy: null,
    since: 1,
    ...over,
  }
}

function macos(running: DashJob[], queued: DashJob[], cap: number | null = 2): ClassBucket[] {
  return [{ cls: 'macos', cap, running, queued }]
}

describe('alertsFor', () => {
  it('says a slot freed only when the pool was full and something is waiting', () => {
    const full = macos([job(1, 1), job(2, 1)], [job(3, 2)])
    const freed = macos([job(1, 1)], [job(3, 2)])

    const alerts = alertsFor(full, freed, ALL)

    expect(alerts.map((a) => a.title)).toEqual(['A macOS slot freed'])
    expect(alerts[0]?.body).toContain('app #2 job-3')
    expect(alertsFor(full, macos([job(1, 1)], []), ALL)).toEqual([])
    expect(alertsFor(macos([job(1, 1)], [job(3, 2)]), macos([], [job(3, 2)]), ALL)).toEqual([])
  })

  it('names a job that went from queued to running', () => {
    const before = macos([], [job(3, 2)])
    const after = macos([job(3, 2)], [])

    const alerts = alertsFor(before, after, ALL)

    expect(alerts.map((a) => a.tag)).toEqual(['started:3'])
    expect(alerts[0]?.title).toBe('app #2 started')
  })

  it('reports a run the moment it becomes superseded, once per run', () => {
    const newer = makeRun({ id: 9, run_number: 9 })
    const before = macos([job(1, 1)], [job(2, 1)])
    const after = macos([job(1, 1, { supersededBy: newer })], [job(2, 1, { supersededBy: newer })])

    const alerts = alertsFor(before, after, ALL)

    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.tag).toBe('stale:1')
    expect(alerts[0]?.body).toContain('#9 replaced it')
    expect(alerts[0]?.body).toContain('holding')
    expect(alertsFor(after, after, ALL)).toEqual([])
  })

  it('stays quiet for anything the reader turned off', () => {
    const before = macos([job(1, 1), job(2, 1)], [job(3, 2)])
    const after = macos([job(3, 2)], [])

    expect(alertsFor(before, after, NO_ALERTS)).toEqual([])
    expect(alertsFor(before, after, { ...NO_ALERTS, jobStarted: true }).map((a) => a.tag)).toEqual([
      'started:3',
    ])
  })

  it('ignores a pool that was not in the previous poll, since nothing is known to have changed', () => {
    expect(alertsFor([], macos([], [job(3, 2)]), ALL)).toEqual([])
  })
})

describe('alerts about the reader’s own runs', () => {
  const ME = 'dana-k'
  const mine = (id: number, runId: number, over: Partial<DashJob> = {}) =>
    job(id, runId, { run: makeRun({ id: runId, run_number: runId, actor: { login: ME } }), ...over })

  function finished(outcome: FinishedRun['outcome'], failed: string[] = [], login = ME): FinishedRun {
    return {
      run: makeRun({ id: 7, run_number: 7, actor: { login } }),
      outcome,
      failedJobs: failed.map((name, i) => ({ id: i, name, url: '' })),
      at: 1,
      cancelledHere: false,
      rerunAsked: false,
    }
  }

  it('says once that the reader’s run started, instead of once per job', () => {
    const before = macos([], [mine(3, 2), mine(4, 2), job(5, 6)])
    const after = macos([mine(3, 2), mine(4, 2), job(5, 6)], [])

    const alerts = alertsFor(before, after, ALL, { login: ME })

    expect(alerts.map((a) => a.tag)).toEqual(['mine-started:2:1', 'started:5'])
    expect(alerts[0]).toMatchObject({ title: 'app #2 started', runId: 2 })
  })

  it('says how the reader’s run ended, as a fact and never a prediction', () => {
    const alerts = alertsFor([], [], ALL, {
      login: ME,
      finished: [finished('failed', ['test-ui']), finished('failed', ['a', 'b'])],
    })

    expect(alerts[0]).toMatchObject({ title: 'app #7 finished', body: 'Job test-ui failed.', runId: 7 })
    expect(alerts[1]?.body).toBe('Jobs a and b failed.')
    expect(alertsFor([], [], ALL, { login: ME, finished: [finished('succeeded')] })[0]?.body).toBe('It passed.')
    for (const a of alerts) expect(a.body).not.toMatch(/\bwill\b/)
  })

  it('says nothing about anyone else’s runs, or without a login', () => {
    const before = macos([], [mine(3, 2)])
    const after = macos([mine(3, 2)], [])

    expect(alertsFor([], [], ALL, { login: ME, finished: [finished('failed', ['x'], 'sam')] })).toEqual([])
    expect(alertsFor(before, after, ALL, { login: null }).map((a) => a.tag)).toEqual(['started:3'])
  })

  it('stays quiet when the reader turned these off', () => {
    const before = macos([], [mine(3, 2)])
    const after = macos([mine(3, 2)], [])

    expect(alertsFor(before, after, NO_ALERTS, { login: ME, finished: [finished('failed', ['x'])] })).toEqual([])
  })
})
