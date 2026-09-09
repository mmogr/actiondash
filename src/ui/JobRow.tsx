import { useState } from 'preact/hooks'
import type { DashJob } from '../model/queue'
import { cancelRun } from '../github/api'
import { now, warning } from '../state/store'
import { pollOnce } from '../github/poller'
import { age, shortSha } from './format'

interface Props {
  entry: DashJob
  /** Queue position, or null for a running job. */
  position: number | null
}

export function JobRow({ entry, position }: Props) {
  const [cancelling, setCancelling] = useState(false)
  const { job, run, repo, supersededBy } = entry
  const nowMs = now.value

  async function onCancel() {
    setCancelling(true)
    try {
      await cancelRun(repo, run.id)
      await pollOnce()
    } catch (err) {
      warning.value = `Could not cancel run ${run.run_number}: ${(err as Error).message}`
    } finally {
      setCancelling(false)
    }
  }

  const staleTitle = supersededBy
    ? `Superseded by run #${supersededBy.run_number} on ${shortSha(supersededBy.head_sha)}`
    : undefined

  return (
    <div class={`row${supersededBy ? ' is-stale' : ''}`}>
      <div class={`pos${position === null ? ' running' : ''}`}>
        {position === null ? 'run' : position}
      </div>
      <div class="repo" title={`${repo.owner}/${repo.name}`}>
        {repo.name}
      </div>
      <a class="runno" href={run.html_url} target="_blank" rel="noreferrer noopener">
        #{run.run_number}
      </a>
      <div class="job" title={job.name}>
        {job.name}
        {supersededBy && (
          <span class="badge" title={staleTitle}>
            STALE
          </span>
        )}
      </div>
      <div class="branch" title={run.head_branch ?? ''}>
        {run.head_branch ?? '-'}
      </div>
      <div class="sha">{shortSha(run.head_sha)}</div>
      <div class="age">{age(entry.since, nowMs)}</div>
      <div class="actions">
        <button onClick={onCancel} disabled={cancelling} title="Cancel this workflow run">
          {cancelling ? '...' : 'cancel'}
        </button>
      </div>
    </div>
  )
}
