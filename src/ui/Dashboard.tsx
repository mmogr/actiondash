import { useEffect } from 'preact/hooks'
import { startPolling, stopPolling } from '../github/poller'
import { distinctRuns } from '../model/queue'
import { settings, updateSettings } from '../state/settings'
import { inferPlan, PLANS } from '../model/plans'
import {
  buckets,
  fatalError,
  firstLoadDone,
  lastPoll,
  polling,
  pollProgress,
  rateLimited,
  stale,
  totalQueued,
  totalRunning,
  warning,
} from '../state/store'
import { RunnerClassSection } from './RunnerClassSection'
import { Footer } from './Footer'

export function Dashboard() {
  useEffect(() => {
    startPolling()
    return stopPolling
  }, [])

  const loading = !firstLoadDone.value
  const progress = pollProgress.value
  const limitedUntil = rateLimited.value
  const list = buckets.value
  const nothingActive = !loading && totalRunning.value === 0 && totalQueued.value === 0

  // The account's real ceiling cannot be read from the API without granting the
  // token profile access, so it is inferred from what has actually been seen
  // running at once. A selection that cannot explain the observations is wrong.
  const observed = settings.value.observedMax
  const plan = PLANS[settings.value.plan]
  const suggested = inferPlan(observed, settings.value.plan)
  const macosExceeded = (observed.macos ?? 0) > plan.macos
  // Counted as runs, so the figure matches the footer's cancel button.
  const staleRunCount = distinctRuns(stale.value).length
  const repoCount = settings.value.repos.length

  return (
    <div class="shell">
      <div class="topbar">
        <div class="brand">
          actiondash <span>/ {repoCount} repos</span>
        </div>
        <div class="topbar-meta">
          <span>
            <span class={`dot${polling.value ? ' live' : ''}`} />
            {polling.value ? 'polling' : 'idle'}
          </span>
          <span>{totalRunning.value} running</span>
          <span>{totalQueued.value} queued</span>
          {staleRunCount > 0 && (
            <span>
              {staleRunCount} superseded run{staleRunCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>

      {limitedUntil !== null && (
        <div class="banner error">
          The hourly request allowance is used up. Polling resumes when it refills at{' '}
          {new Date(limitedUntil * 1000).toLocaleTimeString()}. This token is shared with anything
          else that uses it, such as the gh command line.
        </div>
      )}

      {suggested !== null && (
        <div class="banner warn">
          <span>
            {macosExceeded
              ? `${observed.macos} macOS jobs have been seen running at once, which the ${plan.label} limit of ${plan.macos} cannot produce.`
              : `${observed.total} jobs have been seen running at once, which the ${plan.label} limit of ${plan.total} cannot produce.`}{' '}
            The meters below are measuring against the wrong ceiling.
          </span>
          <button onClick={() => updateSettings({ plan: suggested })}>
            Use {PLANS[suggested].label}
          </button>
        </div>
      )}

      {fatalError.value && <div class="banner error">{fatalError.value}</div>}

      {warning.value && (
        <div class="banner warn">
          <span>{warning.value}</span>
          <button class="link" onClick={() => (warning.value = null)}>
            dismiss
          </button>
        </div>
      )}

      {loading ? (
        <section class="section">
          <div class="section-head">
            <div class="section-title">Loading</div>
            <div class="meter" role="img" aria-label="Loading progress">
              <div
                class="meter-fill"
                style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
              />
            </div>
            <div class="section-stats">
              <span>
                <b>{progress.done}</b> of {progress.total} repositories
              </span>
            </div>
          </div>
          <div class="empty">
            Checking each repository for running and queued jobs. Rows appear as they arrive.
          </div>
        </section>
      ) : nothingActive ? (
        <section class="section">
          <div class="section-head">
            <div class="section-title">All clear</div>
            <div class="section-stats">
              <span>{repoCount} repositories checked</span>
            </div>
          </div>
          <div class="empty">
            No jobs are running or queued in any watched repository. Nothing is competing for a
            concurrency slot right now.
            {lastPoll.value ? ` Last checked ${new Date(lastPoll.value).toLocaleTimeString()}.` : ''}
          </div>
        </section>
      ) : (
        list.map((bucket) => <RunnerClassSection key={bucket.cls} bucket={bucket} />)
      )}

      <Footer />
    </div>
  )
}
