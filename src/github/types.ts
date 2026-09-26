/** Subset of the GitHub REST shapes that this application actually reads. */

export interface RepoRef {
  owner: string
  name: string
}

export function repoKey(r: RepoRef): string {
  return `${r.owner}/${r.name}`
}

export function parseRepo(full: string): RepoRef | null {
  const parts = full.trim().replace(/^https?:\/\/github\.com\//i, '').split('/')
  if (parts.length < 2) return null
  const [owner, name] = parts
  if (!owner || !name) return null
  return { owner, name: name.replace(/\.git$/, '') }
}

export interface Repo {
  full_name: string
  owner: { login: string }
  name: string
  private: boolean
  pushed_at: string | null
  archived: boolean
}

export interface User {
  login: string
  name: string | null
}

/** A workflow run as returned by GET /repos/{o}/{r}/actions/runs. */
export interface WorkflowRun {
  id: number
  name: string | null
  run_number: number
  workflow_id: number
  head_branch: string | null
  head_sha: string
  status: string
  conclusion: string | null
  event: string
  created_at: string
  updated_at: string
  run_started_at?: string
  html_url: string
  /** Present in the listing payload; optional so older fixtures still type-check. */
  head_commit?: { message: string } | null
  /** Who the run belongs to: the pusher, or whoever opened the pull request. */
  actor?: { login: string } | null
  /** Who set this attempt going, when it differs, such as someone re-running it. */
  triggering_actor?: { login: string } | null
  run_attempt?: number
}

/** A run annotated with the repository it was fetched from. */
export interface RunWithRepo extends WorkflowRun {
  repoOwner: string
  repoName: string
}

/** A job as returned by GET /repos/{o}/{r}/actions/runs/{id}/jobs. */
export interface WorkflowJob {
  id: number
  run_id: number
  name: string
  status: string
  conclusion: string | null
  labels: string[]
  runner_name: string | null
  created_at: string
  started_at: string | null
  /** Present once the job completes; optional so older fixtures still type-check. */
  completed_at?: string | null
  html_url: string
  /** The job's steps, in order. Optional for the same reason. */
  steps?: WorkflowStep[]
}

/** One step of a job, as the jobs listing reports it. */
export interface WorkflowStep {
  /** One-based position in the job. */
  number: number
  name: string
  status: string
  conclusion: string | null
}

export type RunnerClass = 'macos' | 'linux' | 'windows' | 'self-hosted' | 'other'
