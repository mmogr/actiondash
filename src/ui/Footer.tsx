import { useState } from 'preact/hooks'
import { PLANS, type PlanId } from '../model/plans'
import { distinctRuns } from '../model/queue'
import { cancelRun } from '../github/api'
import { clearJobCache, pollOnce, stopPolling } from '../github/poller'
import { forgetEverything, settings, updateSettings } from '../state/settings'
import {
  effectiveIntervalMs,
  lastPoll,
  pollCost,
  projectedHourlyCost,
  rateLimit,
  resetData,
  stale,
  view,
  warning,
} from '../state/store'
import { clockTime } from './format'

const INTERVALS = [
  { ms: 10_000, label: '10s' },
  { ms: 15_000, label: '15s' },
  { ms: 30_000, label: '30s' },
  { ms: 60_000, label: '60s' },
]

export function Footer() {
  const [cancelling, setCancelling] = useState(false)
  const staleJobs = stale.value
  const staleRuns = distinctRuns(staleJobs)
  const limit = rateLimit.value
  const polled = lastPoll.value
  const cost = pollCost.value
  const hourly = projectedHourlyCost.value
  const interval = effectiveIntervalMs.value
  // True when the budget forced a slower cadence than the one chosen.
  const slowed = interval > settings.value.pollIntervalMs + 500

  async function cancelAllStale() {
    const count = staleRuns.length
    const ok = confirm(
      `Cancel ${count} superseded run${count === 1 ? '' : 's'}? ` +
        `Each has already been replaced by a newer commit on the same branch.`,
    )
    if (!ok) return

    setCancelling(true)
    const failures: string[] = []
    for (const { repo, run } of staleRuns) {
      try {
        await cancelRun(repo, run.id)
      } catch (err) {
        failures.push(`#${run.run_number}: ${(err as Error).message}`)
      }
    }
    setCancelling(false)
    warning.value = failures.length > 0 ? `Some cancels failed. ${failures.join(' ')}` : null
    await pollOnce()
  }

  function onForget() {
    if (!confirm('Remove the stored token and all settings from this browser?')) return
    stopPolling()
    clearJobCache()
    resetData()
    forgetEverything()
    view.value = 'setup'
  }

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

      {/* Stating the plan outright is newer evidence than an old inference, so
          the observation restarts rather than arguing with the choice. */}
      <label>
        Plan
        <select
          value={settings.value.plan}
          onChange={(e) =>
            updateSettings({
              plan: (e.target as HTMLSelectElement).value as PlanId,
              observedMax: {},
            })
          }
        >
          {Object.values(PLANS).map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      <label>
        Refresh
        <select
          value={String(settings.value.pollIntervalMs)}
          onChange={(e) =>
            updateSettings({ pollIntervalMs: Number((e.target as HTMLSelectElement).value) })
          }
        >
          {INTERVALS.map((i) => (
            <option key={i.ms} value={String(i.ms)}>
              {i.label}
            </option>
          ))}
        </select>
      </label>

      <div class="footer-actions">
        {staleRuns.length > 0 && (
          <button class="danger" onClick={cancelAllStale} disabled={cancelling}>
            {cancelling
              ? 'Cancelling...'
              : `Cancel ${staleRuns.length} superseded run${staleRuns.length === 1 ? '' : 's'}`}
          </button>
        )}

        <button onClick={() => void pollOnce()}>Refresh now</button>
        <button onClick={() => (view.value = 'setup')}>Repositories</button>
        <button class="danger" onClick={onForget}>
          Forget token
        </button>
      </div>
    </div>
  )
}
