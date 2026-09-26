import { useState } from 'preact/hooks'
import type { WorkflowJob } from '../github/types'
import { runOutlook, type BucketForecast, type JobForecast } from '../model/forecast'
import { jobStep, runProgress, type RunGroup as Group } from '../model/queue'
import { RUNNER_CLASS_LABEL } from '../model/runnerClass'
import { forecasts, frozenAt, jobsByRun, now, runsAsOf } from '../state/store'
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

/** "test-ui", "test-ui and lint", or "3 jobs". */
function jobNames(jobs: readonly WorkflowJob[]): string {
  if (jobs.length === 1) return jobs[0]!.name
  if (jobs.length === 2) return `${jobs[0]!.name} and ${jobs[1]!.name}`
  return `${jobs.length} jobs`
}

/** Where "usually" comes from, for the tooltip, so the figure can be weighed. */
function usualTitle(f: JobForecast | undefined): string | undefined {
  if (!f || f.typical === null) return undefined
  if (f.guessed) return 'A guess from other jobs in this pool; this one has not been seen to succeed yet.'
  return `Usually ${duration(f.typical)}, from ${f.samples} successful run${f.samples === 1 ? '' : 's'}.`
}

function LogLink({ job }: { job: WorkflowJob }) {
  return (
    <a
      class="joblog"
      href={job.html_url}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`Log of ${job.name}, on GitHub`}
    >
      log ↗
    </a>
  )
}

export function RunGroup({ group, kind, defaultOpen, forecast }: Props) {
  const [open, setOpen] = useState(defaultOpen)
  const cancel = useCancelRun(group.repo, group.run)
  const nowMs = now.value
  const { run, jobs, supersededBy } = group
  const first = jobs[0]
  const last = jobs[jobs.length - 1]
  const single = jobs.length === 1
  // Shown from an older answer: its repository did not answer this time.
  const asOf = runsAsOf.value.get(run.id) ?? null
  const behind = asOf !== null || frozenAt.value !== null

  // The whole run, across every pool its jobs use, not only this group's slice.
  const progress = runProgress(jobsByRun.value.get(run.id))
  const outlook = runOutlook(run.id, [...forecasts.value.values()].map((v) => v.forecast))
  const pool = RUNNER_CLASS_LABEL[first?.entry.cls ?? 'macos']
  const total = progress.done + progress.running + progress.queued

  // A job that failed while the rest of its run carries on. Said where the run
  // holds slots, or where it waits for them when nothing of it is running, and
  // said as a fact: continue-on-error can leave the run itself to pass.
  const failed = progress.failed.length > 0 && (kind === 'running' || progress.running === 0) ? progress.failed : []
  const failedAt = Math.max(0, ...failed.map((j) => (j.completed_at ? Date.parse(j.completed_at) : 0)))

  const countLabel = single ? first?.entry.job.name : `${jobs.length} jobs`
  const positions =
    kind === 'queued' && first && last
      ? single
        ? `position ${first.position}`
        : `positions ${first.position} to ${last.position}`
      : null
  const bucketOutlook = forecast?.runs.get(run.id)
  const doneBy = outlook?.allDone ?? null
  const eta =
    kind === 'queued' && bucketOutlook && bucketOutlook.firstStart !== null
      ? single
        ? `starts ~${shortClock(bucketOutlook.firstStart)}${doneBy === null ? '' : `, done ~${shortClock(doneBy)}`}`
        : `first job starts ~${shortClock(bucketOutlook.firstStart)}${doneBy === null ? '' : `, all done ~${shortClock(doneBy)}`}`
      : null
  const progressNote =
    kind !== 'running'
      ? null
      : total <= 1
        ? doneBy === null
          ? null
          : `done ~${shortClock(doneBy)}`
        : [
            progress.done > 0 ? `${progress.done} done` : null,
            `${progress.running} running`,
            progress.queued > 0 ? `${progress.queued} waiting` : null,
            doneBy === null ? null : `current jobs done ~${shortClock(doneBy)}`,
          ]
            .filter(Boolean)
            .join(' · ')

  const classes = ['group']
  if (supersededBy) classes.push('is-stale')
  if (behind) classes.push('is-behind')
  if (failed.length > 0) classes.push('has-failed')

  return (
    <div class={classes.join(' ')}>
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
            {run.name && <span class="group-workflow">{run.name}</span>}
            {supersededBy && <span class="badge">STALE</span>}
            {asOf !== null && <span class="asof">as of {shortClock(asOf)}</span>}
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
          {failed.length > 0 && (
            <div class="group-note failed">
              {jobNames(failed)} failed{failedAt > 0 ? ` ${age(failedAt, nowMs)} ago` : ''} ·{' '}
              {kind === 'running'
                ? `still holds ${jobs.length} ${pool} slot${jobs.length === 1 ? '' : 's'}`
                : `${jobs.length} ${single ? 'job' : 'jobs'} still waiting for ${pool} slots`}
            </div>
          )}
          {progressNote && <div class="group-note">{progressNote}</div>}
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
            class={supersededBy || failed.length > 0 ? 'danger' : ''}
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

      {open && (!single || (kind === 'running' && forecast) || failed.length > 0) && (
        <div class="jobs">
          {failed.map((job) => {
            const step = jobStep(job)
            return (
              <div class="jobrow failed" key={job.id}>
                <div class="jobline">
                  <span class="jobmark" aria-hidden="true">
                    ✗
                  </span>
                  <span class="jobname" title={job.name}>
                    {job.name}
                  </span>
                  <span class="group-age">failed</span>
                  <LogLink job={job} />
                </div>
                {step && (
                  <div class="jobstep">
                    at step {step.number} of {step.total} · {step.name}
                  </div>
                )}
              </div>
            )
          })}
          {jobs.map(({ entry, position }) => {
            const f = forecast?.jobs.get(entry.job.id)
            const elapsed = entry.since > 0 ? (nowMs - entry.since) / 1000 : 0
            const pct =
              f && f.typical ? Math.min(100, Math.round((elapsed / f.typical) * 100)) : null
            const step = kind === 'running' ? jobStep(entry.job) : null
            return (
              <div class="jobrow" key={entry.job.id}>
                <div class="jobline">
                  {kind === 'queued' && <span class="pos">{position}</span>}
                  <span class="jobname" title={entry.job.name}>
                    {entry.job.name}
                    {f?.overdue && <span class="overdue-tag">past usual</span>}
                  </span>
                  <span class={`group-age${f?.overdue ? ' warn' : ''}`} title={usualTitle(f)}>
                    {kind === 'running'
                      ? f && f.typical
                        ? `${age(entry.since, nowMs)} · usually ${f.guessed ? '~' : ''}${duration(f.typical)}`
                        : age(entry.since, nowMs)
                      : f && f.start > 0
                        ? `~${shortClock(f.start)}${f.typical ? ` · ${f.guessed ? '~' : ''}${duration(f.typical)}` : ''}`
                        : ''}
                  </span>
                  {kind === 'running' && <LogLink job={entry.job} />}
                </div>
                {step && (
                  <div class="jobstep">
                    step {step.number} of {step.total} · {step.name}
                  </div>
                )}
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
