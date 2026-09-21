import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCache } from '../src/github/client'
import { clearJobCache, pollOnce, stopPolling } from '../src/github/poller'
import type { RunWithRepo, WorkflowJob } from '../src/github/types'
import { settings } from '../src/state/settings'
import * as store from '../src/state/store'
import { FakeGitHub, json, type Reply } from './fake-github'
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

function scriptJobs(runId: number, jobs: WorkflowJob[]): void {
  for (const job of jobs) scriptedJobIds.add(job.id)
  scriptJobsReply(runId, json({ total_count: jobs.length, jobs }))
}

function scriptJobsReply(runId: number, reply: Reply): void {
  gh.on(new RegExp(`/actions/runs/${runId}/jobs\\?`), reply)
}

function macos(): ReturnType<typeof store.buckets.peek>[number] | undefined {
  return store.buckets.value.find((b) => b.cls === 'macos')
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
    store.resetData()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
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
})
