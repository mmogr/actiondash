import { settings } from '../state/settings'
import { effectiveIntervalMs, lastPoll, pollCost, projectedHourlyCost, rateLimit } from '../state/store'
import { clockTime } from './format'

/** The status line: when the data was last refreshed and what it is costing. */
export function Footer() {
  const limit = rateLimit.value
  const polled = lastPoll.value
  const cost = pollCost.value
  const hourly = projectedHourlyCost.value
  const interval = effectiveIntervalMs.value
  // True when the budget forced a slower cadence than the one chosen.
  const slowed = interval > settings.value.pollIntervalMs + 500

  return (
    <div class="footer">
      <span>{polled ? `Updated ${clockTime(polled)}` : 'Not yet polled'}</span>

      {limit && (
        <span title={`Resets at ${clockTime(limit.reset * 1000)}`}>
          {limit.remaining.toLocaleString()} of {limit.limit.toLocaleString()} left
        </span>
      )}

      {cost > 0 && (
        <span
          title={
            `Each refresh spends ${cost} rate-limited request${cost === 1 ? '' : 's'}. ` +
            `Unchanged data answers 304, which GitHub does not charge for. ` +
            `At the current cadence that is about ${hourly.toLocaleString()} an hour ` +
            `against a ${limit ? limit.limit.toLocaleString() : '5,000'} hourly allowance.`
          }
        >
          {cost}/refresh, ~{hourly.toLocaleString()}/hr
        </span>
      )}

      {slowed && (
        <span
          class="slowed"
          title="The refresh interval was stretched automatically to stay inside the hourly request budget."
        >
          paced to {Math.round(interval / 1000)}s
        </span>
      )}
    </div>
  )
}
