/** Typed wrappers over the handful of GitHub endpoints this dashboard uses. */
import { apiFetch, apiFetchAll, type ApiOptions } from './client'
import { JOBS_QUERY, runsQuery, type RunStatus } from './queries'
import type { Repo, RepoRef, RunWithRepo, User, WorkflowJob, WorkflowRun } from './types'

function repoPath(r: RepoRef): string {
  return `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`
}

export async function getUser(): Promise<User> {
  const res = await apiFetch<User>('/user', { noCache: true })
  return res.data
}

/**
 * Repositories the token can reach. A fine-grained token restricted to selected
 * repositories returns exactly those, which is the list the picker wants.
 */
export async function listRepos(): Promise<Repo[]> {
  const repos = await apiFetchAll<Repo>(
    '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
    { noCache: true },
  )
  return repos.filter((r) => !r.archived)
}

/** Active runs of one status. The API accepts a single status per call. */
export async function listRuns(
  repo: RepoRef,
  status: RunStatus,
  options?: ApiOptions,
): Promise<RunWithRepo[]> {
  const res = await apiFetch<{ workflow_runs: WorkflowRun[] }>(
    `${repoPath(repo)}/actions/runs${runsQuery(status)}`,
    options,
  )
  return (res.data.workflow_runs ?? []).map((run) => ({
    ...run,
    repoOwner: repo.owner,
    repoName: repo.name,
  }))
}

export async function listJobs(
  repo: RepoRef,
  runId: number,
  options?: ApiOptions,
): Promise<WorkflowJob[]> {
  const res = await apiFetch<{ jobs: WorkflowJob[] }>(
    `${repoPath(repo)}/actions/runs/${runId}/jobs${JOBS_QUERY}`,
    options,
  )
  return res.data.jobs ?? []
}

/**
 * Cancels a run. A run that has already begun tearing down answers 409, in
 * which case force-cancel is the documented follow-up.
 */
export async function cancelRun(repo: RepoRef, runId: number): Promise<void> {
  try {
    await apiFetch(`${repoPath(repo)}/actions/runs/${runId}/cancel`, {
      method: 'POST',
      noCache: true,
    })
  } catch (err) {
    if (err instanceof Error && 'status' in err && (err as { status: number }).status === 409) {
      await apiFetch(`${repoPath(repo)}/actions/runs/${runId}/force-cancel`, {
        method: 'POST',
        noCache: true,
      })
      return
    }
    throw err
  }
}

/**
 * Re-runs the jobs of a finished run that failed, and the jobs that depend on
 * them. Needs the same Actions write access as cancelling.
 */
export async function rerunFailedJobs(repo: RepoRef, runId: number): Promise<void> {
  await apiFetch(`${repoPath(repo)}/actions/runs/${runId}/rerun-failed-jobs`, {
    method: 'POST',
    noCache: true,
  })
}

/** Re-runs every job of a finished run, such as one cancelled by mistake. */
export async function rerunRun(repo: RepoRef, runId: number): Promise<void> {
  await apiFetch(`${repoPath(repo)}/actions/runs/${runId}/rerun`, { method: 'POST', noCache: true })
}

/** Confirms the token really carries Actions access on a specific repository. */
export async function probeActionsAccess(repo: RepoRef): Promise<void> {
  await apiFetch(`${repoPath(repo)}/actions/runs?per_page=1`, { noCache: true })
}
