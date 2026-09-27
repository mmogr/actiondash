import type { Insight } from '../model/forecast'
import { duration, relative } from './format'
import { useCancelRun } from './useCancelRun'

interface Props {
  insight: Insight
  nowMs: number
}

/**
 * Says which superseded run is worth cancelling first and what that buys,
 * with the cancel right there. Same two-step confirm as the run itself.
 */
export function InsightCard({ insight, nowMs }: Props) {
  const cancel = useCancelRun(insight.repo, insight.run)
  const saving = insight.startsAt - insight.startsAtIfCancelled
  const who = insight.beneficiary
  const startsNow = insight.startsAtIfCancelled <= nowMs + 30_000

  return (
    // Not a live region: the countdown in this text changes every second.
    <div class="insight">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4" />
        <path d="M12 16h.01" />
      </svg>
      <div class="insight-text">
        {/* Said from where the run stands: holding slots, or first in line for one. */}
        {insight.holding > 0 ? (
          <>
            <b>
              {insight.repo.name} #{insight.run.run_number}
            </b>{' '}
            is superseded by #{insight.supersededBy.run_number} but holds {insight.holding}{' '}
            {insight.holding === 1 ? 'slot' : 'slots'}.
          </>
        ) : (
          <>
            The next free slot goes to{' '}
            <b>
              {insight.repo.name} #{insight.run.run_number}
            </b>
            , which is superseded by #{insight.supersededBy.run_number}.
          </>
        )}{' '}
        Cancelling it starts{' '}
        {who.job.name} (#{who.run.run_number}){' '}
        {startsNow ? 'now' : relative(insight.startsAtIfCancelled, nowMs)}
        {/* Behind a job past its usual time the start is a floor, so the saving is at least the figure. */}
        , {insight.basis === 'floor' ? 'at least' : 'about'} {duration(saving / 1000)} sooner.
      </div>
      {cancel.confirming ? (
        <div class="insight-actions" role="group" aria-label="Confirm cancel" onKeyDown={cancel.onKeyDown}>
          <button ref={cancel.keepRef} onClick={cancel.keep}>
            Keep
          </button>
          <button class="danger solid" onClick={() => void cancel.confirm()}>
            Yes, cancel #{insight.run.run_number}
          </button>
        </div>
      ) : cancel.cancelling ? (
        <span ref={cancel.statusRef} role="status" tabIndex={-1} class="group-cancelling">
          cancelling…
        </span>
      ) : (
        <button ref={cancel.askRef} class="danger" onClick={cancel.ask}>
          Cancel #{insight.run.run_number}
        </button>
      )}
    </div>
  )
}
