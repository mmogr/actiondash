import { useState } from 'preact/hooks'
import type { BucketForecast } from '../model/forecast'
import type { RunGroup as Group } from '../model/queue'
import { now } from '../state/store'
import { age, duration, shortClock, shortSha } from './format'
import { seriesClass } from './palette'
import { useCancelRun } from './useCancelRun'

interface Props {
  group: Group
  kind: 'running' | 'queued'
  defaultOpen: boolean
  forecast?: BucketForecast
}

/** First line of the commit message, or the short SHA when the API sent none. */
function describe(group: Group): string {
  const message = group.run.head_commit?.message?.split('\n')[0]?.trim()
  return message || shortSha(group.run.head_sha)
}

export function RunGroup({ group, kind, defaultOpen, forecast }: Props) {
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
  const outlook = forecast?.runs.get(run.id)
  const eta =
    kind === 'queued' && outlook && outlook.firstStart !== null
      ? single
        ? `starts ~${shortClock(outlook.firstStart)}${outlook.allDone === null ? '' : `, done ~${shortClock(outlook.allDone)}`}`
        : `first job starts ~${shortClock(outlook.firstStart)}${outlook.allDone === null ? '' : `, all done ~${shortClock(outlook.allDone)}`}`
      : null

  return (
    <div class={`group${supersededBy ? ' is-stale' : ''}`}>
      <div class="group-head">
        <button
          class="group-toggle"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={`Jobs of ${group.repo.name} #${run.run_number}`}
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
          {positions && !supersededBy && (
            <div class="group-note">
              Queue {positions}
              {eta ? ` · ${eta}` : ''}
            </div>
          )}
          {positions && supersededBy && eta && <div class="group-note">{eta}</div>}
        </div>

        {cancel.cancelling ? (
          <span class="group-cancelling">cancelling…</span>
        ) : (
          <button
            ref={cancel.askRef}
            class={supersededBy ? 'danger' : ''}
            onClick={cancel.confirming ? cancel.keep : cancel.ask}
            aria-expanded={cancel.confirming}
            aria-label={`Cancel ${group.repo.name} run #${run.run_number}${single ? '' : ` (${jobs.length} jobs)`}`}
            title="Cancel this workflow run"
          >
            cancel
          </button>
        )}
      </div>

      {cancel.confirming && (
        <div
          class="group-confirm"
          role="group"
          aria-label="Confirm cancel"
          onKeyDown={cancel.onKeyDown}
        >
          <span>
            Cancel run #{run.run_number}
            {single ? '' : ` and its ${jobs.length} jobs`}?
          </span>
          <button ref={cancel.keepRef} onClick={cancel.keep}>
            Keep
          </button>
          <button class="danger solid" onClick={() => void cancel.confirm()}>
            Yes, cancel
          </button>
        </div>
      )}

      {open && (!single || (kind === 'running' && forecast)) && (
        <div class="jobs">
          {jobs.map(({ entry, position }) => {
            const f = forecast?.jobs.get(entry.job.id)
            const elapsed = entry.since > 0 ? (nowMs - entry.since) / 1000 : 0
            const pct =
              f && f.typical ? Math.min(100, Math.round((elapsed / f.typical) * 100)) : null
            return (
              <div class="jobrow" key={entry.job.id}>
                <div class="jobline">
                  {kind === 'queued' && <span class="pos">{position}</span>}
                  <span class="jobname" title={entry.job.name}>
                    {entry.job.name}
                    {f?.overdue && <span class="overdue-tag">past usual</span>}
                  </span>
                  <span class={`group-age${f?.overdue ? ' warn' : ''}`}>
                    {kind === 'running'
                      ? f && f.typical
                        ? `${age(entry.since, nowMs)} · usually ${f.guessed ? '~' : ''}${duration(f.typical)}`
                        : age(entry.since, nowMs)
                      : f && f.start > 0
                        ? `~${shortClock(f.start)}${f.typical ? ` · ${f.guessed ? '~' : ''}${duration(f.typical)}` : ''}`
                        : ''}
                  </span>
                </div>
                {kind === 'running' && pct !== null && (
                  <div class="progress" aria-hidden="true">
                    <div class={`progress-fill${f?.overdue ? ' over' : ''}`} style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
