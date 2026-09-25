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
    <div class="insight" role="status">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4" />
        <path d="M12 16h.01" />
      </svg>
      <div class="insight-text">
        The next free slot goes to{' '}
        <b>
          {insight.repo.name} #{insight.run.run_number}
        </b>
        , which is superseded by #{insight.supersededBy.run_number}. Cancelling it starts{' '}
        {who.job.name} (#{who.run.run_number}){' '}
        {startsNow ? 'now' : relative(insight.startsAtIfCancelled, nowMs)}, about{' '}
        {duration(saving / 1000)} sooner.
      </div>
      {cancel.confirming ? (
        <div class="insight-actions">
          <button onClick={cancel.keep}>Keep</button>
          <button class="danger solid" onClick={() => void cancel.confirm()}>
            Yes, cancel #{insight.run.run_number}
          </button>
        </div>
      ) : cancel.cancelling ? (
        <span class="group-cancelling">cancelling…</span>
      ) : (
        <button class="danger" onClick={cancel.ask}>
          Cancel #{insight.run.run_number}
        </button>
      )}
    </div>
  )
}
