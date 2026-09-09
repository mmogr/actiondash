import type { RunWithRepo, WorkflowJob } from '../src/github/types'

let nextId = 1

export function makeRun(over: Partial<RunWithRepo> = {}): RunWithRepo {
  const id = over.id ?? nextId++
  return {
    id,
    name: 'CI',
    run_number: id,
    workflow_id: 100,
    head_branch: 'feature',
    head_sha: 'a'.repeat(40),
    status: 'queued',
    conclusion: null,
    event: 'push',
    created_at: '2026-09-09T10:00:00Z',
    updated_at: '2026-09-09T10:00:00Z',
    html_url: `https://github.com/acme/app/actions/runs/${id}`,
    repoOwner: 'acme',
    repoName: 'app',
    ...over,
  }
}

export function makeJob(over: Partial<WorkflowJob> = {}): WorkflowJob {
  const id = over.id ?? nextId++
  return {
    id,
    run_id: over.run_id ?? 1,
    name: 'build',
    status: 'queued',
    conclusion: null,
    labels: ['macos-14'],
    runner_name: null,
    created_at: '2026-09-09T10:00:00Z',
    started_at: null,
    html_url: `https://github.com/acme/app/actions/runs/1/job/${id}`,
    ...over,
  }
}
