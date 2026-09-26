import { useState } from 'preact/hooks'
import type { FinishedRun, Outcome } from '../model/finished'
import { now, recentlyFinished } from '../state/store'
import { rerun } from './actions'
import { age } from './format'
import { seriesClass } from './palette'
import { useConfirm } from './useConfirm'

const SHOWN = 5

/** A mark as well as a colour for each outcome, so none relies on colour. */
const MARK: Record<Outcome, string> = {
  failed: '✗',
  succeeded: '✓',
  cancelled: '⊘',
  left: '–',
  unknown: '?',
}

/**
 * Runs this page saw finish, and how. It turns "All clear" from a dead end
 * into the place to see what just failed, and to try it again.
 */
export function RecentlyFinished() {
  const list = recentlyFinished.value
  const [all, setAll] = useState(false)
  if (list.length === 0) return null
  const nowMs = now.value
  const shown = all ? list : list.slice(0, SHOWN)

  return (
    <section class="section finished">
      <div class="section-head">
        <div class="section-title">Recently finished</div>
        <div class="section-stats">
          <span>seen by this page</span>
        </div>
      </div>
      <div class="rows">
        {shown.map((f) => (
          <FinishedRow key={f.run.id} f={f} nowMs={nowMs} />
        ))}
      </div>
      {list.length > SHOWN && (
        <button class="link finished-more" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${list.length}`}
        </button>
      )}
    </section>
  )
}

function OutcomeText({ f }: { f: FinishedRun }) {
  switch (f.outcome) {
    case 'failed':
      return (
        <>
          {f.failedJobs.map((job, i) => (
            <span key={job.id}>
              {i > 0 ? ' · ' : ''}
              <a href={job.url} target="_blank" rel="noreferrer noopener">
                {job.name}
              </a>{' '}
              failed
            </span>
          ))}
        </>
      )
    case 'succeeded':
      return <>passed</>
    case 'cancelled':
      return <>{f.cancelledHere ? 'cancelled from this page' : 'cancelled'}</>
    case 'left':
      return <>left the queue unfinished; it may be waiting for an approval</>
    case 'unknown':
      return <>finished; result not checked while the hourly allowance was low</>
  }
}

function FinishedRow({ f, nowMs }: { f: FinishedRun; nowMs: number }) {
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  const repo = { owner: f.run.repoOwner, name: f.run.repoName }
  const n = f.run.run_number
  // Re-running is offered where it helps: failed jobs, or a cancel made here.
  const mode = f.outcome === 'failed' ? 'failed' : f.outcome === 'cancelled' && f.cancelledHere ? 'all' : null
  const count = f.failedJobs.length
  const question =
    mode === 'failed'
      ? `Re-run the ${count === 1 ? 'failed job' : `${count} failed jobs`} of ${repo.name} #${n}? They join the queue again.`
      : `Re-run ${repo.name} #${n} from the start? It joins the queue again.`

  async function go() {
    if (!mode) return
    confirm.done()
    setBusy(true)
    await rerun(repo, f.run, mode)
    setBusy(false)
  }

  return (
    <div class={`finished-row ${f.outcome}`}>
      <div class="finished-line">
        <span class={`outcome-mark ${f.outcome}`} aria-hidden="true">
          {MARK[f.outcome]}
        </span>
        <span class={`swatch ${seriesClass(repo)}`} />
        <span class="group-repo">
          {repo.name}{' '}
          <a class="runno" href={f.run.html_url} target="_blank" rel="noreferrer noopener">
            #{n}
          </a>
        </span>
        {f.run.name && <span class="group-workflow">{f.run.name}</span>}
        <span class="group-age">{age(f.at, nowMs)} ago</span>
        {mode && !f.rerunAsked && (
          busy ? (
            <span class="group-cancelling">re-running…</span>
          ) : (
            <button
              ref={confirm.askRef}
              onClick={confirm.confirming ? confirm.keep : confirm.ask}
              aria-expanded={confirm.confirming}
            >
              {mode === 'failed' ? 'Re-run failed' : 'Re-run'}
            </button>
          )
        )}
      </div>
      <div class={`finished-outcome ${f.outcome}`}>
        <OutcomeText f={f} />
      </div>
      {f.rerunAsked && <div class="group-note">Re-run requested. It joins the queue on the next check.</div>}
      {confirm.confirming && (
        <div class="group-confirm" role="group" aria-label="Confirm re-run" onKeyDown={confirm.onKeyDown}>
          <span>{question}</span>
          <button ref={confirm.keepRef} onClick={confirm.keep}>
            Keep
          </button>
          <button class="primary" onClick={() => void go()}>
            Yes, re-run
          </button>
        </div>
      )}
    </div>
  )
}
