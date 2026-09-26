import { lastPoll, now, pollCost, projectedHourlyCost, rateLimit } from '../state/store'
import { age, clockTime } from './format'

/** The status line: when the data was last refreshed and what it is costing. */
export function Footer() {
  const limit = rateLimit.value
  const polled = lastPoll.value
  const cost = pollCost.value
  const hourly = projectedHourlyCost.value

  return (
    <div class="footer">
      {polled ? (
        <span title={clockTime(polled)}>Updated {age(polled, now.value)} ago</span>
      ) : (
        <span>Not yet checked</span>
      )}

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
    </div>
  )
}
