import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCache } from '../src/github/client'
import { clearJobCache, pollOnce, startPolling, stopPolling } from '../src/github/poller'
import type { RunWithRepo, WorkflowJob } from '../src/github/types'
import { settings } from '../src/state/settings'
import { clearDurations, durations } from '../src/state/durations'
import { durationKey, typicalSeconds } from '../src/model/durations'
import * as store from '../src/state/store'
import { deferred, FakeGitHub, json, type Reply } from './fake-github'
import { makeJob, makeRun } from './helpers'

/**
 * pollOnce end to end, against a scripted GitHub.
 *
 * Assertions read only the exported store and the log of requests made, never
 * the poller's internals, so these tests describe what the dashboard shows
 * rather than how it gets there.
 */

const TOKEN = 'github_pat_SENTINEL_must_not_leak_0123456789'
const REPO = { owner: 'acme', name: 'app' }

let gh: FakeGitHub
let scriptedJobIds: Set<number>
let consoleOutput: unknown[][]

function scriptRuns(queued: RunWithRepo[], running: RunWithRepo[]): void {
  gh.on(/\/actions\/runs\?status=queued&/, json({ total_count: queued.length, workflow_runs: queued }))
  gh.on(
    /\/actions\/runs\?status=in_progress&/,
    json({ total_count: running.length, workflow_runs: running }),
  )
}

function jobsReply(jobs: WorkflowJob[]): Reply {
  for (const job of jobs) scriptedJobIds.add(job.id)
  return json({ total_count: jobs.length, jobs })
}

function scriptJobs(runId: number, jobs: WorkflowJob[]): void {
  scriptJobsReply(runId, jobsReply(jobs))
}

function scriptJobsReply(runId: number, reply: Reply): void {
  gh.on(new RegExp(`/actions/runs/${runId}/jobs\\?`), reply)
}

function macos(): ReturnType<typeof store.buckets.peek>[number] | undefined {
  return store.buckets.value.find((b) => b.cls === 'macos')
}

/** Lets pending promise callbacks run until the condition holds. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((r) => setTimeout(r, 0))
  expect(condition()).toBe(true)
}

/** Everything the store holds, as text, for checking nothing secret got in. */
function storeAsText(): string {
  const values = Object.entries(store)
    .filter(([, v]) => typeof v === 'object' && v !== null && 'value' in v)
    .map(([k, v]) => [k, (v as { value: unknown }).value])
  return JSON.stringify(values, (_k, v: unknown) => (v instanceof Map ? [...v] : v))
}

beforeEach(() => {
  gh = new FakeGitHub().install()
  scriptedJobIds = new Set()
  consoleOutput = []
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args)
    })
  }
  settings.value = {
    token: TOKEN,
    repos: [REPO],
    plan: 'pro',
    pollIntervalMs: 15_000,
    observedMax: {},
  }
})

afterEach(() => {
  try {
    // Conservation: a job is shown at most once, and only if GitHub reported it.
    const shown = store.buckets.value.flatMap((b) => [...b.running, ...b.queued]).map((j) => j.job.id)
    expect(new Set(shown).size).toBe(shown.length)
    for (const id of shown) expect(scriptedJobIds).toContain(id)

    // The token goes in the Authorization header and nowhere else. The path
    // that could leak it is a GitHubError's url, through describe(), into the
    // warning banner.
    for (const call of gh.calls) {
      expect(call.url).not.toContain(TOKEN)
      expect(call.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
      expect(String(call.body ?? '')).not.toContain(TOKEN)
    }
    expect(JSON.stringify(consoleOutput)).not.toContain(TOKEN)
    expect(storeAsText()).not.toContain(TOKEN)
  } finally {
    stopPolling()
    clearJobCache()
    clearCache()
    clearDurations()
    store.resetData()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
})

describe('pollOnce', () => {
  it('shows what GitHub reports running and waiting', async () => {
    const running = makeRun({ id: 1, status: 'in_progress' })
    const waiting = makeRun({ id: 2, status: 'queued' })
    scriptRuns([waiting], [running])
    scriptJobs(1, [makeJob({ run_id: 1, status: 'in_progress' })])
    scriptJobs(2, [makeJob({ run_id: 2, status: 'queued' })])

    await pollOnce()

    expect(macos()?.running).toHaveLength(1)
    expect(macos()?.queued).toHaveLength(1)
    expect(store.warning.value).toBeNull()
    expect(store.fatalError.value).toBeNull()
    expect(store.firstLoadDone.value).toBe(true)
    expect(gh.calls).toHaveLength(4)
  })

  it('keeps the last snapshot and says so when a job listing fails', async () => {
    const jobs = Array.from({ length: 5 }, () => makeJob({ run_id: 1, status: 'in_progress' }))
    scriptRuns([], [makeRun({ id: 1, status: 'in_progress', updated_at: '2026-09-09T10:00:00Z' })])
    scriptJobs(1, jobs)
    await pollOnce()
    expect(macos()?.running).toHaveLength(5)

    // The run moves, so its jobs are due a refetch, and GitHub has a bad moment.
    scriptRuns([], [makeRun({ id: 1, status: 'in_progress', updated_at: '2026-09-09T10:01:00Z' })])
    scriptJobsReply(1, json({ message: 'Server Error' }, { status: 502 }))
    await pollOnce()

    // A failure says nothing about whether the jobs still hold slots, so the
    // pool must not read as empty, and the reader must be told.
    expect(macos()?.running).toHaveLength(5)
    expect(store.warning.value).toContain('Server Error')
  })

  it('reports a failed job listing on the first poll', async () => {
    scriptRuns([], [makeRun({ id: 1, status: 'in_progress' })])
    scriptJobsReply(1, json({ message: 'Server Error' }, { status: 502 }))

    await pollOnce()

    expect(store.warning.value).toContain('Server Error')
  })

  it('drops a run that finished between the run and job listings', async () => {
    // GitHub answers 404 for the jobs of a run that is gone. It no longer holds
    // a slot, so it is correct to show nothing and to say nothing.
    scriptRuns([], [makeRun({ id: 1, status: 'in_progress' })])
    scriptJobsReply(1, json({ message: 'Not Found' }, { status: 404 }))

    await pollOnce()

    expect(macos()?.running).toHaveLength(0)
    expect(macos()?.queued).toHaveLength(0)
    expect(store.warning.value).toBeNull()
  })

  it('never lets a superseded poll overwrite newer job data', async () => {
    // Cancelling from a row starts a new poll at once, so an older poll whose
    // job listing is still on its way back is the everyday case.
    scriptRuns([], [makeRun({ id: 1, status: 'in_progress' })])
    const older = deferred()
    scriptJobsReply(1, older.reply)
    const first = pollOnce()
    await until(() => gh.calls.some((c) => c.url.includes('/runs/1/jobs')))

    const current = makeJob({ run_id: 1, status: 'in_progress' })
    scriptJobs(1, [current])
    await pollOnce()

    older.resolve(jobsReply([makeJob({ run_id: 1, status: 'queued' })]))
    await first
    // A third poll reads the job cache, which is where a late write would land.
    await pollOnce()

    expect(macos()?.running.map((j) => j.job.id)).toEqual([current.id])
    expect(macos()?.queued).toHaveLength(0)
  })

  it('cancels its requests when polling stops', async () => {
    const hanging = deferred({ honourAbort: true })
    gh.on(/\/actions\/runs\?status=/, hanging.reply)
    const poll = pollOnce()
    await until(() => gh.calls.length === 2)

    stopPolling()
    await poll

    // Aborting has to reach fetch, or the requests run on and are billed.
    for (const call of gh.calls) expect(call.signal?.aborted).toBe(true)
    expect(store.firstLoadDone.value).toBe(false)
  })
})

describe('learning durations', () => {
  const START = '2026-09-09T10:00:00Z'
  const KEY = durationKey(REPO, 'build')

  function finished(id: number, minutes: number, runId = 1): WorkflowJob {
    return makeJob({
      id,
      run_id: runId,
      name: 'build',
      status: 'completed',
      conclusion: 'success',
      started_at: START,
      completed_at: new Date(Date.parse(START) + minutes * 60_000).toISOString(),
    })
  }

  it('learns from a job that completed inside a run that is still active', async () => {
    const run = makeRun({ id: 1, status: 'in_progress' })
    scriptRuns([], [run])
    scriptJobs(1, [finished(10, 7), makeJob({ id: 11, run_id: 1, status: 'in_progress' })])

    await pollOnce()

    expect(typicalSeconds(durations.value, KEY)).toBe(420)
  })

  it('fetches the final jobs of a run that finished between polls, once', async () => {
    const run = makeRun({ id: 1, status: 'in_progress' })
    scriptRuns([], [run])
    scriptJobs(1, [makeJob({ id: 10, run_id: 1, name: 'build', status: 'in_progress' })])
    await pollOnce()

    scriptRuns([], [])
    scriptJobs(1, [finished(10, 9)])
    await pollOnce()
    const listings = () => gh.calls.filter((c) => c.url.includes('/runs/1/jobs')).length
    const afterSecond = listings()
    await pollOnce()

    expect(typicalSeconds(durations.value, KEY)).toBe(540)
    expect(afterSecond).toBe(2)
    expect(listings()).toBe(2)
  })

  it('does not chase a finished run whose jobs were all already complete', async () => {
    const run = makeRun({ id: 1, status: 'in_progress' })
    scriptRuns([], [run])
    scriptJobs(1, [finished(10, 9)])
    await pollOnce()

    scriptRuns([], [])
    await pollOnce()

    expect(gh.calls.filter((c) => c.url.includes('/runs/1/jobs'))).toHaveLength(1)
  })

  it('skips the final listing when the hourly allowance is nearly spent', async () => {
    const run = makeRun({ id: 1, status: 'in_progress' })
    const low = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '150', 'x-ratelimit-reset': '9999999999' }
    scriptRuns([], [run])
    scriptJobs(1, [makeJob({ id: 10, run_id: 1, name: 'build', status: 'in_progress' })])
    await pollOnce()

    gh.on(/\/actions\/runs\?status=queued&/, json({ total_count: 0, workflow_runs: [] }, { headers: low }))
    gh.on(/\/actions\/runs\?status=in_progress&/, json({ total_count: 0, workflow_runs: [] }, { headers: low }))
    scriptJobs(1, [finished(10, 9)])
    await pollOnce()

    expect(gh.calls.filter((c) => c.url.includes('/runs/1/jobs'))).toHaveLength(1)
    expect(typicalSeconds(durations.value, KEY)).toBeUndefined()
  })
})

describe('pacing', () => {
  it('honours a retry-after from any response in the poll, not just the last', async () => {
    // Requests in one poll run concurrently, so which one answers last is
    // chance. A backoff GitHub asked for must not depend on it.
    gh.on(
      /\/actions\/runs\?status=queued&/,
      json({ total_count: 0, workflow_runs: [] }, { headers: { 'retry-after': '60' } }),
    )
    gh.on(
      /\/actions\/runs\?status=in_progress&/,
      json({ total_count: 1, workflow_runs: [makeRun({ id: 1, status: 'in_progress' })] }),
    )
    scriptJobs(1, [makeJob({ run_id: 1, status: 'in_progress' })])

    startPolling()
    await until(() => store.effectiveIntervalMs.value > 0)

    expect(store.effectiveIntervalMs.value).toBe(60_000)
  })

  it('forgets a retry-after once the poll that received it is over', async () => {
    const empty = { total_count: 0, workflow_runs: [] }
    gh.on(/\/actions\/runs\?status=/, json(empty, { headers: { 'retry-after': '60' } }))
    await pollOnce()
    gh.on(/\/actions\/runs\?status=/, json(empty))

    startPolling()
    await until(() => store.effectiveIntervalMs.value > 0)

    expect(store.effectiveIntervalMs.value).toBe(15_000)
  })
})

describe('rate limiting', () => {
  it('starts no new request once the allowance is refused', async () => {
    const runs = Array.from({ length: 10 }, (_, i) => makeRun({ id: i + 1, status: 'in_progress' }))
    scriptRuns([], runs)
    const replies = runs.map((run) => {
      const reply = deferred()
      scriptJobsReply(run.id, reply.reply)
      return reply
    })
    const jobCalls = () => gh.calls.filter((c) => c.url.includes('/jobs?'))

    const poll = pollOnce()
    await until(() => jobCalls().length > 0)
    const inFlight = jobCalls().length
    const reset = Math.floor(Date.now() / 1000) + 600
    replies[0]!.resolve(
      json(
        { message: 'API rate limit exceeded' },
        {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
        },
      ),
    )
    await poll
    expect(store.rateLimited.value).toBe(reset)

    // The requests already on their way finish; nothing new may start.
    for (const reply of replies.slice(1)) reply.resolve(jobsReply([]))
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
    expect(jobCalls()).toHaveLength(inFlight)
  })
})

describe('pollOnce, with job snapshots of different ages', () => {
  // Only Date is faked: the snapshot ages are what matter, and until() still
  // needs real timers to let promise callbacks run.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-21T10:00:00Z'))
  })

  const inProgress = (n: number, runId: number) =>
    Array.from({ length: n }, () => makeJob({ run_id: runId, status: 'in_progress' }))
  const finished = (jobs: WorkflowJob[]) =>
    jobs.map((j) => ({ ...j, status: 'completed', conclusion: 'success' }))
  const jobCalls = (runId: number) => gh.calls.filter((c) => c.url.includes(`/runs/${runId}/jobs`))

  /** Five macOS jobs, then thirty seconds, then three more in a new run. */
  async function fiveThenThreeMore(firstFiveStillRunning: boolean): Promise<void> {
    const early = makeRun({ id: 1, status: 'in_progress' })
    const five = inProgress(5, 1)
    scriptRuns([], [early])
    scriptJobs(1, five)
    await pollOnce()
    expect(macos()?.running).toHaveLength(5)

    // Past the sampling window but inside the job cache's staleness limit, and
    // the first run's updated_at has not moved, so its snapshot is reused.
    vi.setSystemTime(Date.now() + 30_000)
    scriptRuns([], [early, makeRun({ id: 2, status: 'in_progress' })])
    scriptJobs(1, firstFiveStillRunning ? five : finished(five))
    scriptJobs(2, inProgress(3, 2))
    await pollOnce()
  }

  it('does not show a pool over its ceiling from a snapshot it has not refreshed', async () => {
    await fiveThenThreeMore(false)

    // The pro plan caps macOS at five. Eight would be the old five, long since
    // finished, counted beside the new three.
    expect(macos()?.running).toHaveLength(3)
    expect(jobCalls(1)).toHaveLength(2)
  })

  it('still shows a genuine excess once the snapshot is fresh', async () => {
    // Over the ceiling for real is what the suspect-observation banner exists
    // for, so re-measuring must not hide it.
    await fiveThenThreeMore(true)

    expect(macos()?.running).toHaveLength(8)
  })

  it('costs nothing extra when the pool is within its ceiling', async () => {
    const early = makeRun({ id: 1, status: 'in_progress' })
    scriptRuns([], [early])
    scriptJobs(1, inProgress(2, 1))
    await pollOnce()

    vi.setSystemTime(Date.now() + 30_000)
    await pollOnce()

    expect(jobCalls(1)).toHaveLength(1)
  })
})
