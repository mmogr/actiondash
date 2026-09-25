import { useState } from 'preact/hooks'
import type { RunGroup as Group } from '../model/queue'
import { now } from '../state/store'
import { age, shortSha } from './format'
import { seriesClass } from './palette'
import { useCancelRun } from './useCancelRun'

interface Props {
  group: Group
  kind: 'running' | 'queued'
  defaultOpen: boolean
}

/** First line of the commit message, or the short SHA when the API sent none. */
function describe(group: Group): string {
  const message = group.run.head_commit?.message?.split('\n')[0]?.trim()
  return message || shortSha(group.run.head_sha)
}

export function RunGroup({ group, kind, defaultOpen }: Props) {
  const [open, setOpen] = useState(defaultOpen)
  const cancel = useCancelRun(group.repo, group.run)
  const nowMs = now.value
  const { run, jobs, supersededBy } = group
  const first = jobs[0]
  const last = jobs[jobs.length - 1]
  const single = jobs.length === 1

  const countLabel = single ? first?.entry.job.name : `${jobs.length} jobs`
  const positions =
    kind === 'queued' && first && last
      ? single
        ? `position ${first.position}`
        : `positions ${first.position} to ${last.position}`
      : null

  return (
    <div class={`group${supersededBy ? ' is-stale' : ''}`}>
      <div class="group-head">
        <button
          class="group-toggle"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} run ${run.run_number}`}
        >
          {open ? '▾' : '▸'}
        </button>

        <div class="group-body">
          <div class="group-line">
            <span class={`swatch ${seriesClass(group.repo)}`} />
            <span class="group-repo" title={`${group.repo.owner}/${group.repo.name}`}>
              {group.repo.name}{' '}
              <a class="runno" href={run.html_url} target="_blank" rel="noreferrer noopener">
                #{run.run_number}
              </a>
            </span>
            {supersededBy && <span class="badge">STALE</span>}
            <span class="group-age">{age(group.since, nowMs)}</span>
          </div>
          <div class="group-meta" title={`${countLabel} · ${run.head_branch ?? '-'} · ${describe(group)}`}>
            <span class="group-count">{countLabel}</span> · {run.head_branch ?? '-'} ·{' '}
            {describe(group)}
          </div>
          {supersededBy && (
            <div class="group-note stale">
              Superseded by #{supersededBy.run_number} on {shortSha(supersededBy.head_sha)}
            </div>
          )}
          {positions && !supersededBy && <div class="group-note">Queue {positions}</div>}
        </div>

        {cancel.cancelling ? (
          <span class="group-cancelling">cancelling…</span>
        ) : (
          <button
            class={supersededBy ? 'danger' : ''}
            onClick={cancel.ask}
            disabled={cancel.confirming}
            title="Cancel this workflow run"
          >
            cancel
          </button>
        )}
      </div>

      {cancel.confirming && (
        <div class="group-confirm" role="group" aria-label="Confirm cancel">
          <span>
            Cancel run #{run.run_number}
            {single ? '' : ` and its ${jobs.length} jobs`}?
          </span>
          <button onClick={cancel.keep}>Keep</button>
          <button class="danger solid" onClick={() => void cancel.confirm()}>
            Yes, cancel
          </button>
        </div>
      )}

      {open && !single && (
        <div class="jobs">
          {jobs.map(({ entry, position }) => (
            <div class="jobrow" key={entry.job.id}>
              {kind === 'queued' && <span class="pos">{position}</span>}
              <span class="jobname" title={entry.job.name}>
                {entry.job.name}
              </span>
              {kind === 'running' && <span class="group-age">{age(entry.since, nowMs)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
