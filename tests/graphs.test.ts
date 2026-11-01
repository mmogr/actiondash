import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCache } from '../src/github/client'
import { clearJobCache, pollOnce, stopPolling } from '../src/github/poller'
import type { RunWithRepo, WorkflowJob } from '../src/github/types'
import { isRunGraph } from '../src/model/workflow'
import { clearDurations } from '../src/state/durations'
import { clearWorkflowCache, graphDenied } from '../src/state/graphs'
import { clearHistory } from '../src/state/history'
import { DEFAULT_SETTINGS, settings } from '../src/state/settings'
import * as store from '../src/state/store'
import { FakeGitHub, json, type Call, type Reply } from './fake-github'
import { makeJob, makeRun } from './helpers'

/**
 * Reading job graphs during a poll, against a scripted GitHub: what is asked
 * for, how often, and what the store ends up showing.
 */

const TOKEN = 'github_pat_SENTINEL_graphs_0123456789'
const REPO = { owner: 'acme', name: 'app' }
const PATH = '.github/workflows/ci.yml'

const WORKFLOW = `
on: push
jobs:
  build:
    runs-on: ubuntu-24.04
    steps: [{ run: make }]
  sign:
    needs: build
    runs-on: macos-15
    steps: [{ run: codesign }]
`
/** The same workflow before a job was renamed, as the default branch still has it. */
const OLD_WORKFLOW = WORKFLOW.replace('sign:', 'notarise:')

let gh: FakeGitHub

function run(over: Partial<RunWithRepo> = {}): RunWithRepo {
  return makeRun({ id: 1, status: 'in_progress', path: PATH, head_sha: 'a'.repeat(40), ...over })
}

const building = (runId = 1, id = 11): WorkflowJob =>
  makeJob({ id, run_id: runId, name: 'build', status: 'in_progress', labels: ['ubuntu-24.04'], started_at: '2026-09-09T10:00:00Z' })

function scriptPoll(runs: RunWithRepo[], jobs: Map<number, WorkflowJob[]>): void {
  gh.on(/\/actions\/runs\?status=queued&/, json({ total_count: 0, workflow_runs: [] }))
  gh.on(/\/actions\/runs\?status=in_progress&/, json({ total_count: runs.length, workflow_runs: runs }))
  for (const [id, list] of jobs) gh.on(new RegExp(`/actions/runs/${id}/jobs\\?`), json({ total_count: list.length, jobs: list }))
}

/** A workflow file, answering 304 when asked with the ETag it has. */
function file(text: string, etag: string): Reply {
  return (call: Call) =>
    call.headers.get('if-none-match') === etag
      ? new Response(null, { status: 304, headers: { etag } })
      : new Response(text, { status: 200, headers: { etag, 'x-ratelimit-remaining': '4000' } })
}

const contentsCalls = () => gh.calls.filter((c) => c.url.includes('/contents/'))

beforeEach(() => {
  gh = new FakeGitHub().install()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  settings.value = { ...DEFAULT_SETTINGS, token: TOKEN, repos: [REPO], plan: 'pro', graphRepos: ['acme/app'] }
})

afterEach(() => {
  try {
    for (const call of gh.calls) {
      expect(call.url).not.toContain(TOKEN)
      expect(call.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
    }
  } finally {
    stopPolling()
    clearJobCache()
    clearCache()
    clearDurations()
    clearHistory()
    clearWorkflowCache()
    store.resetData()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

describe('reading job graphs', () => {
  it('reads nothing for a repository not opted in', async () => {
    settings.value = { ...settings.value, graphRepos: [] }
    scriptPoll([run()], new Map([[1, [building()]]]))
    await pollOnce()
    expect(contentsCalls()).toHaveLength(0)
    expect(store.graphs.value.size).toBe(0)
  })

  it('reads the workflow file at the run\'s commit and shows the jobs still to come', async () => {
    scriptPoll([run()], new Map([[1, [building()]]]))
    gh.on(/\/contents\//, file(WORKFLOW, '"blob1"'))
    await pollOnce()

    expect(contentsCalls().map((c) => c.url)).toEqual([
      `https://api.github.com/repos/acme/app/contents/.github/workflows/ci.yml?ref=${'a'.repeat(40)}`,
    ])
    expect(contentsCalls()[0]!.headers.get('accept')).toBe('application/vnd.github.raw+json')
    const g = store.graphs.value.get(1)!
    expect(isRunGraph(g)).toBe(true)
    expect(store.graphOutlooks.value.get(1)?.future.has('sign')).toBe(true)
  })

  it('asks about a run once, and reads an unchanged file for a new run for free', async () => {
    scriptPoll([run()], new Map([[1, [building()]]]))
    gh.on(/\/contents\//, file(WORKFLOW, '"blob1"'))
    await pollOnce()
    await pollOnce()
    expect(contentsCalls()).toHaveLength(1)

    // A new commit, same file: the ETag from the first commit still matches.
    const second = run({ id: 2, head_sha: 'b'.repeat(40) })
    scriptPoll([run(), second], new Map([[1, [building()]], [2, [building(2, 21)]]]))
    await pollOnce()
    const calls = contentsCalls()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.url).toContain(`ref=${'b'.repeat(40)}`)
    expect(calls[1]!.headers.get('if-none-match')).toBe('"blob1"')
    expect(isRunGraph(store.graphs.value.get(2)!)).toBe(true)
  })

  it('falls back to the default branch when the commit\'s copy does not explain the run', async () => {
    // The run lists a job the copy at its commit does not have, as when a
    // pull request's merge commit differs from its head.
    const jobs = [makeJob({ id: 11, run_id: 1, name: 'build', status: 'completed', conclusion: 'success', labels: ['ubuntu-24.04'], started_at: '2026-09-09T10:00:00Z', completed_at: '2026-09-09T10:05:00Z' }),
      makeJob({ id: 12, run_id: 1, name: 'notarise', status: 'queued', labels: ['macos-15'], created_at: '2026-09-09T10:05:00Z' })]
    scriptPoll([run()], new Map([[1, jobs]]))
    gh.on(/\/contents\/.*\?ref=/, file(WORKFLOW, '"blob1"'))
    gh.on(/\/contents\/[^?]*$/, file(OLD_WORKFLOW, '"blob0"'))
    await pollOnce()

    expect(contentsCalls().map((c) => c.url.includes('?ref='))).toEqual([true, false])
    const g = store.graphs.value.get(1)!
    expect(isRunGraph(g) && g.graph.nodes.map((n) => n.id)).toEqual(['build', 'notarise'])
  })

  it('shows no graph, and says why, when neither copy explains the run', async () => {
    const jobs = [makeJob({ id: 11, run_id: 1, name: 'lint', status: 'in_progress', labels: ['ubuntu-24.04'] })]
    scriptPoll([run()], new Map([[1, jobs]]))
    gh.on(/\/contents\//, file(WORKFLOW, '"blob1"'))
    await pollOnce()
    const g = store.graphs.value.get(1)!
    expect(isRunGraph(g)).toBe(false)
    expect('reason' in g && g.reason).toMatch(/"lint" is not in the workflow file/)
  })

  it('names a repository whose files the token cannot read', async () => {
    scriptPoll([run()], new Map([[1, [building()]]]))
    gh.on(/\/contents\//, json({ message: 'Resource not accessible by personal access token' }, { status: 403 }))
    await pollOnce()
    expect(graphDenied.value.get('acme/app')).toBe('Resource not accessible by personal access token')
    expect(store.dataHealth.value).toBe('ok')
    expect(contentsCalls()).toHaveLength(1)
  })

  it('reads nothing for a workflow GitHub writes itself', async () => {
    scriptPoll([run({ path: 'dynamic/dependabot/dependabot-updates' })], new Map([[1, [building()]]]))
    await pollOnce()
    expect(contentsCalls()).toHaveLength(0)
    expect(store.graphs.value.get(1)).toMatchObject({ reason: expect.any(String) })
  })

  it('reads nothing while the hourly allowance is nearly spent', async () => {
    scriptPoll([run()], new Map([[1, [building()]]]))
    gh.on(/\/actions\/runs\?status=in_progress&/, (call) => {
      const r = json({ total_count: 1, workflow_runs: [run()] }, { headers: { 'x-ratelimit-remaining': '150', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1789000000' } })
      return r(call)
    })
    gh.on(/\/actions\/runs\?status=queued&/, json({ total_count: 0, workflow_runs: [] }, { headers: { 'x-ratelimit-remaining': '150', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1789000000' } }))
    gh.on(/\/actions\/runs\/1\/jobs\?/, json({ total_count: 1, jobs: [building()] }, { headers: { 'x-ratelimit-remaining': '150', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1789000000' } }))
    await pollOnce()
    expect(contentsCalls()).toHaveLength(0)
    // Not recorded as unavailable, so it is read once there is room again.
    expect(store.graphs.value.has(1)).toBe(false)
  })

  it('drops a repository\'s graphs as soon as it is turned off', async () => {
    scriptPoll([run()], new Map([[1, [building()]]]))
    gh.on(/\/contents\//, file(WORKFLOW, '"blob1"'))
    await pollOnce()
    expect(store.graphs.value.size).toBe(1)
    settings.value = { ...settings.value, graphRepos: [] }
    await pollOnce()
    expect(store.graphs.value.size).toBe(0)
  })
})
