import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCache, GitHubError } from '../src/github/client'
import { probeRepos } from '../src/github/api'
import { clearJobCache, pollOnce, refreshNow, startPolling, stopPolling } from '../src/github/poller'
import type { RunWithRepo, WorkflowJob } from '../src/github/types'
import { DEFAULT_SETTINGS, settings } from '../src/state/settings'
import { clearDurations, durations } from '../src/state/durations'
import { clearHistory, history } from '../src/state/history'
import { durationKey, typicalSeconds } from '../src/model/durations'
import * as store from '../src/state/store'
import { deferred, empty, FakeGitHub, json, type Reply } from './fake-github'
import { cancelRuns, rerun } from '../src/ui/actions'
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

/** Run listings for one repository only, for tests that watch several. */
function scriptRunsFor(
  repo: { owner: string; name: string },
  queued: RunWithRepo[],
  running: RunWithRepo[],
): void {
  const base = `/repos/${repo.owner}/${repo.name}/actions/runs\\?status=`
  gh.on(new RegExp(`${base}queued&`), json({ total_count: queued.length, workflow_runs: queued }))
  gh.on(new RegExp(`${base}in_progress&`), json({ total_count: running.length, workflow_runs: running }))
}

/**
 * Both run listings of one repository answer with the same failure. Declared
 * as the same routes scriptRunsFor uses, so it replaces them in place.
 */
function failRunsFor(repo: { owner: string; name: string }, reply: Reply): void {
  const base = `/repos/${repo.owner}/${repo.name}/actions/runs\\?status=`
  gh.on(new RegExp(`${base}queued&`), reply)
  gh.on(new RegExp(`${base}in_progress&`), reply)
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
  settings.value = { ...DEFAULT_SETTINGS, token: TOKEN, repos: [REPO], plan: 'pro' }
})

afterEach(() => {
  try {
    // Conservation: a job is shown at most once, and only if GitHub reported it.
    const shown = store.buckets.value.flatMap((b) => [...b.running, ...b.queued]).map((j) => j.job.id)
    expect(new Set(shown).size).toBe(shown.length)
    for (const id of shown) expect(scriptedJobIds).toContain(id)

    // The token goes in the Authorization header and nowhere else. The path
    // that could leak it is a GitHubError's message, through a repository's
    // problem detail, into the store.
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
    clearHistory()
    store.resetData()
    store.online.value = true
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
    expect(store.repoProblems.value.size).toBe(0)
    expect(store.dataHealth.value).toBe('ok')
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
    expect(store.repoProblems.value.get('acme/app')?.detail).toContain('Server Error')
    expect(store.runsAsOf.value.has(1)).toBe(true)
  })

  it('reports a failed job listing on the first poll', async () => {
    scriptRuns([], [makeRun({ id: 1, status: 'in_progress' })])
    scriptJobsReply(1, json({ message: 'Server Error' }, { status: 502 }))

    await pollOnce()

    expect(store.repoProblems.value.get('acme/app')?.problem).toBe('server')
  })

  it('drops a run that finished between the run and job listings', async () => {
    // GitHub answers 404 for the jobs of a run that is gone. It no longer holds
    // a slot, so it is correct to show nothing and to say nothing.
    scriptRuns([], [makeRun({ id: 1, status: 'in_progress' })])
    scriptJobsReply(1, json({ message: 'Not Found' }, { status: 404 }))

    await pollOnce()

    expect(macos()?.running).toHaveLength(0)
    expect(macos()?.queued).toHaveLength(0)
    expect(store.repoProblems.value.size).toBe(0)
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

describe('when GitHub cannot be reached', () => {
  const APP = { owner: 'acme', name: 'app' }
  const SITE = { owner: 'acme', name: 'site' }
  const T0 = Date.parse('2026-09-21T10:00:00Z')
  const serverError = json({ message: 'Server Error' }, { status: 502 })
  const jobCalls = (runId: number) => gh.calls.filter((c) => c.url.includes(`/runs/${runId}/jobs`))

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    settings.value = { ...settings.value, repos: [APP, SITE] }
  })

  /** A first poll where both repositories answer, each with one running run. */
  async function bothAnswer(): Promise<void> {
    scriptRunsFor(APP, [], [makeRun({ id: 1, status: 'in_progress' })])
    scriptRunsFor(SITE, [], [makeRun({ id: 2, repoName: 'site', status: 'in_progress' })])
    scriptJobs(1, [makeJob({ run_id: 1, status: 'in_progress' })])
    scriptJobs(2, [makeJob({ run_id: 2, status: 'in_progress' })])
    await pollOnce()
    expect(macos()?.running).toHaveLength(2)
  }

  it("keeps a repository's last good runs, marked, while it does not answer", async () => {
    await bothAnswer()

    vi.setSystemTime(T0 + 60_000)
    failRunsFor(SITE, serverError)
    await pollOnce()

    // Its run did not finish just because nobody could ask about it.
    expect(macos()?.running).toHaveLength(2)
    expect(store.runsAsOf.value.get(2)).toBe(T0)
    expect(store.dataHealth.value).toBe('partial')
    expect(store.repoProblems.value.get('acme/site')).toMatchObject({ problem: 'server', asOf: T0 })
  })

  it('stops standing in after ten minutes, and spends nothing on the runs it drops', async () => {
    await bothAnswer()
    failRunsFor(SITE, serverError)

    vi.setSystemTime(T0 + 10 * 60_000 + 1_000)
    await pollOnce()

    expect(macos()?.running.map((j) => j.run.id)).toEqual([1])
    expect(store.repoProblems.value.get('acme/site')?.asOf).toBeNull()
    // Not seen is not finished: no final listing is fetched to learn from.
    expect(jobCalls(2)).toHaveLength(1)
  })

  it('never stands in for a repository the token cannot see', async () => {
    await bothAnswer()

    failRunsFor(SITE, json({ message: 'Not Found' }, { status: 404 }))
    await pollOnce()

    expect(macos()?.running.map((j) => j.run.id)).toEqual([1])
    expect(store.repoProblems.value.get('acme/site')?.problem).toBe('missing')
    expect(jobCalls(2)).toHaveLength(1)
  })

  it('says it could not check, not that all is clear, when nothing answers', async () => {
    failRunsFor(APP, serverError)
    failRunsFor(SITE, serverError)

    await pollOnce()

    expect(store.firstLoadDone.value).toBe(true)
    expect(store.totalRunning.value + store.totalQueued.value).toBe(0)
    expect(store.dataHealth.value).toBe('unreachable')
  })

  it('says the allowance is used up, not that all is clear, when the first poll is refused', async () => {
    const reset = Math.floor(T0 / 1000) + 600
    gh.on(
      /\/actions\/runs\?status=/,
      json(
        { message: 'API rate limit exceeded' },
        { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } },
      ),
    )

    await pollOnce()

    expect(store.dataHealth.value).toBe('limited')
    expect(store.rateLimited.value).toBe(reset)
  })

  it('records no history for a poll that missed a repository', async () => {
    await bothAnswer()
    const recorded = () => history.value.samples.at(-1)?.until

    vi.setSystemTime(T0 + 15_000)
    failRunsFor(SITE, serverError)
    await pollOnce()
    expect(recorded()).toBe(T0)

    vi.setSystemTime(T0 + 30_000)
    scriptRunsFor(SITE, [], [makeRun({ id: 2, repoName: 'site', status: 'in_progress' })])
    await pollOnce()
    expect(recorded()).toBe(T0 + 30_000)
  })

  it('still records history when the only repository missing is one the token cannot see', async () => {
    await bothAnswer()

    vi.setSystemTime(T0 + 15_000)
    failRunsFor(SITE, json({ message: 'Not Found' }, { status: 404 }))
    await pollOnce()

    expect(history.value.samples.at(-1)?.until).toBe(T0 + 15_000)
  })

  it('gives a poll with a stand-in no vote on the ceiling', async () => {
    // Each poll moves both runs, so their jobs are read fresh and every poll
    // would be a fair sample, but for the stand-in.
    const moved = (i: number) => `2026-09-21T10:0${i}:00Z`
    const poll = async (i: number, siteAnswers: boolean) => {
      vi.setSystemTime(T0 + i * 15_000)
      scriptRunsFor(APP, [], [makeRun({ id: 1, status: 'in_progress', updated_at: moved(i) })])
      if (siteAnswers) {
        scriptRunsFor(SITE, [], [makeRun({ id: 2, repoName: 'site', status: 'in_progress', updated_at: moved(i) })])
      } else {
        failRunsFor(SITE, serverError)
      }
      await pollOnce()
    }

    await bothAnswer()
    for (let i = 1; i <= 3; i++) await poll(i, false)
    expect(settings.value.observedMax).toEqual({})

    for (let i = 4; i <= 6; i++) await poll(i, true)
    expect(settings.value.observedMax.macos).toBe(2)
  })

  it('asks nothing while offline', async () => {
    store.online.value = false

    await pollOnce()

    expect(gh.calls).toHaveLength(0)
    expect(store.dataHealth.value).toBe('offline')
  })
})

describe('the poll schedule', () => {
  it('stops for good once the token is rejected', async () => {
    gh.on(/\/actions\/runs\?status=/, json({ message: 'Bad credentials' }, { status: 401 }))

    startPolling()
    await until(() => store.view.value === 'setup')
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))

    // The poll that saw the 401 ends by scheduling the next one, unless the
    // poller remembers it was stopped.
    expect(store.nextPollAt.value).toBeNull()
    expect(refreshNow({ force: true })).toBe(false)
    // Remembered, so a reload lands on recovery rather than a dead dashboard.
    expect(settings.value.tokenRejectedAt).toEqual(expect.any(Number))
    store.view.value = 'dashboard'
  })

  it('refuses a refresh on demand within ten seconds of the last poll', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-09-21T10:00:00Z'))
    scriptRuns([], [])

    startPolling()
    await until(() => store.nextPollAt.value !== null)
    const asked = gh.calls.length

    expect(refreshNow()).toBe(false)
    expect(gh.calls).toHaveLength(asked)

    vi.setSystemTime(Date.now() + 10_000)
    expect(refreshNow()).toBe(true)
    await until(() => gh.calls.length > asked)
  })
})

describe('finished runs', () => {
  const START = '2026-09-09T10:00:00Z'
  const running = (id: number, runId = 1, name = 'build') =>
    makeJob({ id, run_id: runId, name, status: 'in_progress', started_at: START })
  const ended = (id: number, conclusion: string, runId = 1, name = 'build') =>
    makeJob({ id, run_id: runId, name, status: 'completed', conclusion, started_at: START, completed_at: START })
  const jobCalls = (runId: number) => gh.calls.filter((c) => c.url.includes(`/runs/${runId}/jobs`))

  /** A run seen running, then gone, with the final listing GitHub gives for it. */
  async function runThatFinishes(finalJobs: WorkflowJob[]): Promise<void> {
    scriptRuns([], [makeRun({ id: 1, status: 'in_progress' })])
    scriptJobs(1, [running(10), running(11, 1, 'test-ui')])
    await pollOnce()
    scriptRuns([], [])
    scriptJobs(1, finalJobs)
    await pollOnce()
  }

  it('names the job that failed in a run that finished between polls', async () => {
    await runThatFinishes([ended(10, 'success'), ended(11, 'failure', 1, 'test-ui')])

    const [finished] = store.recentlyFinished.value
    expect(finished?.outcome).toBe('failed')
    expect(finished?.failedJobs.map((j) => j.name)).toEqual(['test-ui'])
  })

  it('tells how a run ended from its last snapshot when that was complete, asking nothing', async () => {
    scriptRuns([], [makeRun({ id: 1, status: 'in_progress' })])
    scriptJobs(1, [ended(10, 'success')])
    await pollOnce()

    scriptRuns([], [])
    await pollOnce()

    expect(store.recentlyFinished.value[0]?.outcome).toBe('succeeded')
    expect(jobCalls(1)).toHaveLength(1)
  })

  it('says a run left unfinished when its final listing still has jobs waiting', async () => {
    await runThatFinishes([ended(10, 'success'), makeJob({ id: 11, run_id: 1, status: 'waiting' })])

    expect(store.recentlyFinished.value[0]?.outcome).toBe('left')
  })

  it('does not guess how a run ended when the allowance was too low to look', async () => {
    const low = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '150', 'x-ratelimit-reset': '9999999999' }
    scriptRuns([], [makeRun({ id: 1, status: 'in_progress' })])
    scriptJobs(1, [running(10)])
    await pollOnce()

    gh.on(/\/actions\/runs\?status=queued&/, json({ total_count: 0, workflow_runs: [] }, { headers: low }))
    gh.on(/\/actions\/runs\?status=in_progress&/, json({ total_count: 0, workflow_runs: [] }, { headers: low }))
    await pollOnce()

    expect(store.recentlyFinished.value[0]?.outcome).toBe('unknown')
  })

  it('never lists as finished a run whose repository stopped answering', async () => {
    scriptRuns([], [makeRun({ id: 1, status: 'in_progress' })])
    scriptJobs(1, [running(10)])
    await pollOnce()

    gh.on(/\/actions\/runs\?status=queued&/, json({ message: 'Server Error' }, { status: 502 }))
    gh.on(/\/actions\/runs\?status=in_progress&/, json({ message: 'Server Error' }, { status: 502 }))
    await pollOnce()

    expect(store.recentlyFinished.value).toEqual([])
  })

  it('re-runs failed jobs, though GitHub answers with no body', async () => {
    await runThatFinishes([ended(10, 'failure')])
    gh.on(/\/runs\/1\/rerun-failed-jobs$/, empty(201))

    const ok = await rerun(REPO, store.recentlyFinished.value[0]!.run, 'failed')

    expect(ok).toBe(true)
    expect(gh.calls.at(-1)).toMatchObject({ method: 'POST' })
    expect(store.recentlyFinished.value[0]?.rerunAsked).toBe(true)
    expect(store.actionError.value).toBeNull()
  })

  it('keeps a failed cancel on screen through the next poll', async () => {
    const a = makeRun({ id: 1, status: 'in_progress' })
    const b = makeRun({ id: 2, status: 'in_progress' })
    gh.on(/\/runs\/1\/cancel$/, json({}, { status: 202 }))
    gh.on(/\/runs\/2\/cancel$/, json({ message: 'Resource not accessible' }, { status: 403 }))

    const done = await cancelRuns(
      [
        { repo: REPO, run: a },
        { repo: REPO, run: b },
      ],
      { spacingMs: 0 },
    )
    scriptRuns([], [])
    await pollOnce()

    expect(done).toBe(1)
    expect(store.actionError.value).toContain('#2')
    expect(store.cancelRequested.value.has(1)).toBe(true)
    expect(store.cancelRequested.value.has(2)).toBe(false)
  })

  it('remembers a run was cancelled from here, so undoing it is offered', async () => {
    const run = makeRun({ id: 1, status: 'in_progress' })
    scriptRuns([], [run])
    scriptJobs(1, [running(10)])
    await pollOnce()

    gh.on(/\/runs\/1\/cancel$/, json({}, { status: 202 }))
    await cancelRuns([{ repo: REPO, run }], { spacingMs: 0 })
    // GitHub still lists it for a moment; it stays marked as asked for.
    await pollOnce()
    expect(store.cancelRequested.value.has(1)).toBe(true)

    scriptRuns([], [])
    scriptJobs(1, [ended(10, 'cancelled')])
    await pollOnce()

    expect(store.recentlyFinished.value[0]).toMatchObject({ outcome: 'cancelled', cancelledHere: true })
    expect(store.cancelRequested.value.has(1)).toBe(false)
  })
})

describe('probeRepos', () => {
  const SITE = { owner: 'acme', name: 'site' }
  const probe = (repo: { owner: string; name: string }) =>
    new RegExp(`/repos/${repo.owner}/${repo.name}/actions/runs\\?per_page=1$`)

  it('checks every repository and names the ones the token cannot read', async () => {
    gh.on(probe(REPO), json({ total_count: 0, workflow_runs: [] }))
    gh.on(probe(SITE), json({ message: 'Not Found' }, { status: 404 }))

    const failures = await probeRepos([REPO, SITE])

    expect(failures.map((f) => f.repo)).toEqual([SITE])
    expect((failures[0]!.error as GitHubError).status).toBe(404)
  })

  it('stops at a rejected token, since every answer would be the same', async () => {
    gh.on(/\/actions\/runs\?per_page=1$/, json({ message: 'Bad credentials' }, { status: 401 }))

    await expect(probeRepos([REPO, SITE])).rejects.toBeInstanceOf(GitHubError)
  })
})
