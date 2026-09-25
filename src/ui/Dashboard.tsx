import { useEffect } from 'preact/hooks'
import { startPolling, stopPolling } from '../github/poller'
import { distinctRuns } from '../model/queue'
import { settings, updateSettings } from '../state/settings'
import { PLANS } from '../model/plans'
import { adviceFor } from '../model/advice'
import {
  buckets,
  fatalError,
  firstLoadDone,
  lastPoll,
  observationDismissed,
  polling,
  pollProgress,
  rateLimited,
  stale,
  tab,
  totalQueued,
  totalRunning,
  warning,
} from '../state/store'
import { RunnerClassSection } from './RunnerClassSection'
import { FilterChips } from './FilterChips'
import { Footer } from './Footer'
import { SettingsView } from './SettingsView'
import { TabBar } from './TabBar'

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

  const observed = settings.value.observedMax
  const plan = PLANS[settings.value.plan]
  const advice = adviceFor(observed, settings.value.plan, observationDismissed.value)
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

      {advice.kind === 'suggest' && (
        <div class="banner warn">
          <span>
            {advice.dimension === 'macos'
              ? `${observed.macos} macOS jobs have been seen running at once, which the ${plan.label} limit of ${plan.macos} cannot produce.`
              : `${observed.total} jobs have been seen running at once, which the ${plan.label} limit of ${plan.total} cannot produce.`}{' '}
            The meters below are measuring against the wrong ceiling.
          </span>
          <div class="banner-actions">
            <button onClick={() => updateSettings({ plan: advice.plan })}>
              Use {PLANS[advice.plan].label}
            </button>
            <button class="link" onClick={() => updateSettings({ observedMax: {} })}>
              My plan is right, recheck
            </button>
          </div>
        </div>
      )}

      {advice.kind === 'suspect' && (
        <div class="banner warn">
          <span>
            {advice.dimension === 'macos'
              ? `${observed.macos} macOS jobs were counted running at once, which ${advice.pastEveryPlan ? 'no published plan' : 'no plan below Enterprise'} allows.`
              : `${observed.total} jobs were counted running at once, which no published plan allows.`}{' '}
            That is more likely a counting problem than a plan problem: the watched repositories may
            span more than one owner, whose pools GitHub meters separately, or a self-hosted machine
            may be counted as a hosted one. Rechecking rebuilds the figure from the next few polls.
          </span>
          <div class="banner-actions">
            <button onClick={() => updateSettings({ observedMax: {} })}>Recheck</button>
            <button class="link" onClick={() => (observationDismissed.value = true)}>
              dismiss
            </button>
          </div>
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

      {tab.value === 'settings' ? (
        <SettingsView />
      ) : tab.value === 'trends' ? (
        <section class="section">
          <div class="section-head">
            <div class="section-title">Trends</div>
          </div>
          <div class="empty">Occupancy over time arrives in the next release.</div>
        </section>
      ) : tab.value === 'alerts' ? (
        <section class="section">
          <div class="section-head">
            <div class="section-title">Alerts</div>
          </div>
          <div class="empty">Notifications arrive in a later release.</div>
        </section>
      ) : loading ? (
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
        <>
          <FilterChips />
          {list.map((bucket, i) => (
            <RunnerClassSection key={bucket.cls} bucket={bucket} headline={i === 0} />
          ))}
        </>
      )}

      <Footer />
      <TabBar />
    </div>
  )
}
