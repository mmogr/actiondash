import { projectedRemaining } from '../../model/budget'
import type { RateLimit } from '../../github/client'
import { clockTime } from '../format'

interface Props {
  limit: RateLimit | null
  hourlyCost: number
  pollCost: number
  intervalMs: number
  nowMs: number
}

/** Requests left this hour, with a tick where the current cadence lands at the reset. */
export function BudgetBar({ limit, hourlyCost, pollCost, intervalMs, nowMs }: Props) {
  if (!limit) {
    return (
      <section class="section">
        <div class="section-head">
          <div class="section-title">API budget this hour</div>
        </div>
        <div class="empty">Known after the first poll.</div>
      </section>
    )
  }
  const msToReset = Math.max(0, limit.reset * 1000 - nowMs)
  const projected = projectedRemaining(limit.remaining, hourlyCost, msToReset)
  const pct = (n: number) => `${limit.limit > 0 ? (n / limit.limit) * 100 : 0}%`
  const secs = Math.round(intervalMs / 1000)
  // The fastest cadence the remaining allowance can sustain until the reset.
  const affordable =
    pollCost > 0 && msToReset > 0
      ? Math.ceil(msToReset / Math.max(1, Math.floor((limit.remaining * 0.6) / pollCost)) / 1000)
      : null

  return (
    <section class="section">
      <div class="section-head">
        <div class="section-title">API budget this hour</div>
        <div class="section-stats">
          <span>
            <b>{limit.remaining.toLocaleString()}</b> of {limit.limit.toLocaleString()} left
          </span>
        </div>
      </div>
      <div class="budget">
        <div
          class="budget-track"
          role="img"
          aria-label={`${limit.remaining} of ${limit.limit} requests left. About ${projected} at the reset at ${clockTime(limit.reset * 1000)} at the current cadence.`}
        >
          <div class="budget-fill" style={{ width: pct(limit.remaining) }} />
          <div class="budget-mark" style={{ left: pct(projected) }} />
        </div>
        <div class="budget-labels">
          <span>0</span>
          <span class="budget-projection" style={{ left: pct(projected) }}>
            ~{projected.toLocaleString()} at reset {clockTime(limit.reset * 1000).slice(0, 5)}
          </span>
          <span>{limit.limit.toLocaleString()}</span>
        </div>
        <div class="budget-note">
          {pollCost > 0
            ? `Refreshing every ${secs}s costs ${pollCost} request${pollCost === 1 ? '' : 's'}.`
            : 'Cost known after the first poll.'}
          {affordable !== null && affordable < secs
            ? ` You could afford every ${affordable}s until the reset.`
            : ''}
        </div>
      </div>
    </section>
  )
}
