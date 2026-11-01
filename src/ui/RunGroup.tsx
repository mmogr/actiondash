import { useEffect, useState } from 'preact/hooks'
import type { RunnerClass, WorkflowJob } from '../github/types'
import { runOutlook, type JobForecast } from '../model/forecast'
import { isCancelRequested } from '../model/finished'
import { isMine } from '../model/mine'
import { jobStep, runProgress, type PositionedJob, type RunEntry } from '../model/queue'
import { RUNNER_CLASS_LABEL } from '../model/runnerClass'
import { joinList } from '../model/setup'
import { isRunGraph } from '../model/workflow'
import {
  aheadOfSelected,
  cancelRequested,
  forecasts,
  frozenAt,
  graphOutlooks,
  graphs,
  jobForecast,
  jobsByRun,
  now,
  runsAsOf,
} from '../state/store'
import { settings } from '../state/settings'
import { age, duration, hedge, shortClock, shortSha } from './format'
import { seriesClass } from './palette'
import { useCancelRun } from './useCancelRun'
import { RunGraph } from './RunGraph'

interface Props {
  entry: RunEntry
  defaultOpen: boolean
}

/** First line of the commit message, or the short SHA when the API sent none. */
function describe(entry: RunEntry): string {
  const message = entry.run.head_commit?.message?.split('\n')[0]?.trim()
  return message || shortSha(entry.run.head_sha)
}

/** "test-ui", "test-ui and lint", or "3 jobs". */
function jobNames(jobs: readonly WorkflowJob[]): string {
  if (jobs.length === 1) return jobs[0]!.name
  if (jobs.length === 2) return `${jobs[0]!.name} and ${jobs[1]!.name}`
  return `${jobs.length} jobs`
}

/** "2 macOS slots", "1 macOS and 2 Linux slots". */
function slotsOf(jobs: readonly PositionedJob[]): string {
  const counts = new Map<RunnerClass, number>()
  for (const { entry } of jobs) counts.set(entry.cls, (counts.get(entry.cls) ?? 0) + 1)
  const total = jobs.length
  return `${joinList([...counts].map(([cls, n]) => `${n} ${RUNNER_CLASS_LABEL[cls]}`))} slot${total === 1 ? '' : 's'}`
}

/** "positions 1 to 4", or "position 5", of a pool's waiting jobs. */
function positionsOf(jobs: readonly PositionedJob[]): string {
  const places = jobs.map((j) => j.position).sort((a, b) => a - b)
  const first = places[0]!
  const last = places[places.length - 1]!
  return first === last ? `position ${first}` : `positions ${first} to ${last}`
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

/**
 * One run in the list: every active job it has, in any pool, and the one
 * cancel that stops them all. A run with a graph is drawn as one; the rest
 * list their jobs with each one's place in its pool's line.
 */
export function RunGroup({ entry, defaultOpen }: Props) {
  const [open, setOpen] = useState(defaultOpen)
  const cancel = useCancelRun(entry.repo, entry.run)
  const nowMs = now.value
  const { run, jobs, supersededBy, state, pools } = entry
  const running = state === 'running'
  const single = jobs.length === 1
  const first = jobs[0]
  // Shown from an older answer: its repository did not answer this time.
  const asOf = runsAsOf.value.get(run.id) ?? null
  const behind = asOf !== null || frozenAt.value !== null
  const requested = isCancelRequested(cancelRequested.value, run.id, nowMs)

  // The whole run, every job its listing reports, across every pool.
  const progress = runProgress(jobsByRun.value.get(run.id))
  const outlook = runOutlook(run.id, [...forecasts.value.values()].map((v) => v.forecast))

  const graphEntry = graphs.value.get(run.id)
  const graph = graphEntry && isRunGraph(graphEntry) ? graphEntry : null
  const whole = graph ? graphOutlooks.value.get(run.id) : undefined
  const ahead = aheadOfSelected.value
  const aheadHere = jobs.filter(({ entry }) => ahead.has(entry.job.id)).length

  // The reader's own run opens to its graph when the graph arrives, which is
  // usually a poll after the run itself: it is the run they are watching.
  const mine = isMine(run, settings.value.login)
  const hasGraph = graph !== null
  useEffect(() => {
    if (hasGraph && mine) setOpen(true)
  }, [hasGraph, mine])

  const total = progress.done + progress.running + progress.queued
  // A cancel stops the whole run, so the question counts every job it stops.
  const unfinished = Math.max(jobs.length, progress.running + progress.queued)
  const stops = unfinished === 1 ? null : `${unfinished} unfinished jobs`

  // A job that failed while the rest of its run carries on, said as a fact:
  // continue-on-error can leave the run itself to pass.
  const failed = progress.failed
  const failedAt = Math.max(0, ...failed.map((j) => (j.completed_at ? Date.parse(j.completed_at) : 0)))
  const heldJobs = jobs.filter((j) => j.entry.job.status === 'in_progress')
  const waitingJobs = jobs.filter((j) => j.entry.job.status !== 'in_progress')

  const countLabel = single ? first?.entry.job.name : `${jobs.length} jobs`
  // Where the run waits: its places in each pool's line, named by pool when
  // it waits in more than one.
  const waitingPools = pools.filter((cls) => waitingJobs.some((j) => j.entry.cls === cls))
  const positions = running
    ? null
    : waitingPools.length === 1
      ? positionsOf(waitingJobs)
      : waitingPools
          .map((cls) => `${RUNNER_CLASS_LABEL[cls]} ${positionsOf(waitingJobs.filter((j) => j.entry.cls === cls))}`)
          .join(' · ')
  // With a graph, done means the whole run, jobs not created yet included.
  const doneBy = whole ? whole.allDone : (outlook?.allDone ?? null)
  const doneBasis = whole ? whole.basis : (outlook?.basis ?? 'learned')
  const doneWord = whole ? 'done' : 'current jobs done'
  const eta =
    !running && outlook && outlook.firstStart !== null
      ? single
        ? `starts ~${shortClock(outlook.firstStart)}${hedge(outlook.basis)}${doneBy === null ? '' : `, done ~${shortClock(doneBy)}${hedge(doneBasis)}`}`
        : `first job starts ~${shortClock(outlook.firstStart)}${hedge(outlook.basis)}${doneBy === null ? '' : `, all done ~${shortClock(doneBy)}${hedge(doneBasis)}`}`
      : null
  const progressNote = !running
    ? null
    : total <= 1
      ? doneBy === null
        ? null
        : `done ~${shortClock(doneBy)}${hedge(doneBasis)}`
      : [
          progress.done > 0 ? `${progress.done} done` : null,
          `${progress.running} running`,
          progress.queued > 0 ? `${progress.queued} waiting` : null,
          doneBy === null ? null : `${doneWord} ~${shortClock(doneBy)}${hedge(doneBasis)}`,
        ]
          .filter(Boolean)
          .join(' · ')

  const classes = ['group']
  if (supersededBy) classes.push('is-stale')
  if (behind) classes.push('is-behind')
  if (failed.length > 0) classes.push('has-failed')

  return (
    <div class={classes.join(' ')} data-run={run.id}>
      <div class="group-head">
        <button
          class="group-toggle"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={`Jobs of ${entry.repo.name} #${run.run_number}`}
        >
          {open ? '▾' : '▸'}
        </button>

        <div class="group-body">
          <div class="group-line">
            <span class={`swatch ${seriesClass(entry.repo)}`} />
            <span class="group-repo" title={`${entry.repo.owner}/${entry.repo.name}`}>
              {entry.repo.name}{' '}
              <a class="runno" href={run.html_url} target="_blank" rel="noreferrer noopener">
                #{run.run_number}
              </a>
            </span>
            {run.name && <span class="group-workflow">{run.name}</span>}
            {mine && <span class="you-tag">you</span>}
            {supersededBy && <span class="badge">STALE</span>}
            {asOf !== null && <span class="asof">as of {shortClock(asOf)}</span>}
            <span class="group-age">{age(entry.since, nowMs)}</span>
          </div>
          <div class="group-meta" title={`${countLabel} · ${run.head_branch ?? '-'} · ${describe(entry)}`}>
            <span class="group-count">{countLabel}</span> · {run.head_branch ?? '-'} ·{' '}
            {describe(entry)}
          </div>
          {supersededBy && (
            <div class="group-note stale">
              Superseded by #{supersededBy.run_number} on {shortSha(supersededBy.head_sha)}
            </div>
          )}
          {failed.length > 0 && (
            <div class="group-note failed">
              {jobNames(failed)} failed{failedAt > 0 ? ` ${age(failedAt, nowMs)} ago` : ''} ·{' '}
              {heldJobs.length > 0
                ? `still holds ${slotsOf(heldJobs)}`
                : `${waitingJobs.length} ${waitingJobs.length === 1 ? 'job' : 'jobs'} still waiting for ${joinList(waitingPools.map((c) => RUNNER_CLASS_LABEL[c]))} slots`}
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
          {aheadHere > 0 && (
            <div class="group-note ahead-note">
              {aheadHere} {aheadHere === 1 ? 'job' : 'jobs'} ahead of the one you picked
            </div>
          )}
        </div>

        {/* One node for both texts, so focus survives the text changing. */}
        {cancel.cancelling || requested ? (
          <span ref={cancel.statusRef} role="status" tabIndex={-1} class="group-cancelling">
            {cancel.cancelling ? 'cancelling…' : 'cancel requested'}
          </span>
        ) : (
          <button
            ref={cancel.askRef}
            class={supersededBy || failed.length > 0 ? 'danger' : ''}
            onClick={cancel.confirming ? cancel.keep : cancel.ask}
            aria-expanded={cancel.confirming}
            aria-label={`Cancel ${entry.repo.name} run #${run.run_number}${stops ? ` (${stops})` : ''}`}
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
            {stops ? ` and its ${stops}` : ''}?
          </span>
          <button ref={cancel.keepRef} onClick={cancel.keep}>
            Keep
          </button>
          <button class="danger solid" onClick={() => void cancel.confirm()}>
            Yes, cancel
          </button>
        </div>
      )}

      {open && graph && (
        <div class="graph-wrap">
          <RunGraph run={run} graph={graph} ahead={ahead} />
        </div>
      )}

      {open && !graph && (!single || running || failed.length > 0) && (
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
          {jobs.map(({ entry: job, position }) => {
            const f = jobForecast(job.job.id)
            const holds = job.job.status === 'in_progress'
            const elapsed = job.since > 0 ? (nowMs - job.since) / 1000 : 0
            const pct = holds && f && f.typical ? Math.min(100, Math.round((elapsed / f.typical) * 100)) : null
            const step = holds ? jobStep(job.job) : null
            return (
              <div class={`jobrow${ahead.has(job.job.id) ? ' ahead' : ''}`} key={job.job.id}>
                <div class="jobline">
                  {!holds && <span class="pos">{position}</span>}
                  <span class="jobname" title={job.job.name}>
                    {job.job.name}
                    {f?.overdue && <span class="overdue-tag">past usual</span>}
                  </span>
                  {/* Named by pool only when the run uses more than one. */}
                  {pools.length > 1 && <span class="jobpool">{RUNNER_CLASS_LABEL[job.cls]}</span>}
                  <span class={`group-age${f?.overdue ? ' warn' : ''}`} title={usualTitle(f)}>
                    {holds
                      ? f && f.typical
                        ? `${age(job.since, nowMs)} · usually ${f.guessed ? '~' : ''}${duration(f.typical)}`
                        : age(job.since, nowMs)
                      : f && f.start > 0
                        ? `~${shortClock(f.start)}${hedge(f.basis)}${f.typical ? ` · ${f.guessed ? '~' : ''}${duration(f.typical)}` : ''}`
                        : ''}
                  </span>
                  {holds && <LogLink job={job.job} />}
                </div>
                {step && (
                  <div class="jobstep">
                    step {step.number} of {step.total} · {step.name}
                  </div>
                )}
                {pct !== null && (
                  <div class="progress" aria-hidden="true">
                    {/* Marked on the same rule as the "past usual" tag, so the two never disagree. */}
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
