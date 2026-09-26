import { useEffect } from 'preact/hooks'
import { getUser } from '../github/api'
import { refreshNow, startPolling, stopPolling } from '../github/poller'
import { distinctRuns } from '../model/queue'
import { settings, updateSettings } from '../state/settings'
import { PLANS } from '../model/plans'
import { adviceFor } from '../model/advice'
import {
  actionError,
  buckets,
  dataHealth,
  fatalError,
  nextPollAt,
  observationDismissed,
  online,
  pollProgress,
  repoProblems,
  stale,
  tab,
  totalQueued,
  totalRunning,
} from '../state/store'
import { CantCheck } from './CantCheck'
import { HealthStrip } from './HealthStrip'
import { StatusPill } from './StatusPill'
import { RunnerClassSection } from './RunnerClassSection'
import { FilterChips } from './FilterChips'
import { Footer } from './Footer'
import { SettingsView } from './SettingsView'
import { TabBar } from './TabBar'
import { Trends } from './trends/Trends'
import { AlertsView } from './AlertsView'
import { InstallBanner } from './InstallBanner'
import { YourRuns } from './YourRuns'
import { RecentlyFinished } from './RecentlyFinished'

export function Dashboard() {
  useEffect(() => {
    const goOnline = () => {
      online.value = true
      refreshNow({ force: true })
    }
    const goOffline = () => {
      online.value = false
    }
    // A hidden tab's timers are throttled, so a poll can be long overdue by
    // the time the reader comes back. Only then is it brought forward.
    const onVisible = () => {
      const due = nextPollAt.peek()
      if (document.visibilityState === 'visible' && due !== null && due < Date.now()) refreshNow()
    }
    online.value = navigator.onLine !== false
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    document.addEventListener('visibilitychange', onVisible)
    startPolling()
    // Set up before the login was kept: one request, once, to learn whose
    // runs are whose. Nothing depends on it, so a failure is left alone.
    if (settings.value.token && settings.value.login === null) {
      getUser()
        .then((user) => updateSettings({ login: user.login }))
        .catch(() => {})
    }
    return () => {
      stopPolling()
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const health = dataHealth.value
  const progress = pollProgress.value
  const list = buckets.value
  const nothingActive = totalRunning.value === 0 && totalQueued.value === 0
  const cantCheck = health === 'offline' || health === 'limited' || health === 'unreachable'
  const answered = settings.value.repos.length - repoProblems.value.size

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
          <StatusPill />
          <span>{totalRunning.value} running</span>
          <span>{totalQueued.value} queued</span>
          {staleRunCount > 0 && (
            <span>
              {staleRunCount} superseded run{staleRunCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>

      {advice.kind === 'suggest' && (
        <div class="banner warn">
          <span>
            {advice.dimension === 'macos'
              ? `${observed.macos} macOS jobs have run at once, more than the ${plan.label} limit of ${plan.macos}.`
              : `${observed.total} jobs have run at once, more than the ${plan.label} limit of ${plan.total}.`}{' '}
            The meters are using the wrong ceiling.
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
              ? `${observed.macos} macOS jobs were counted running at once, more than ${advice.pastEveryPlan ? 'any published plan' : 'any plan below Enterprise'} allows.`
              : `${observed.total} jobs were counted running at once, more than any published plan allows.`}{' '}
            More likely the count is off: repositories from more than one account, or a self-hosted
            machine counted as hosted.
          </span>
          <div class="banner-actions">
            <button onClick={() => updateSettings({ observedMax: {} })}>Recheck</button>
            <button class="link" onClick={() => (observationDismissed.value = true)}>
              dismiss
            </button>
          </div>
        </div>
      )}

      {fatalError.value && (
        <div class="banner error" role="alert">
          {fatalError.value}
        </div>
      )}

      {actionError.value && (
        <div class="banner error" role="alert">
          <span>{actionError.value}</span>
          <button class="link" onClick={() => (actionError.value = null)}>
            dismiss
          </button>
        </div>
      )}

      {tab.value === 'settings' ? (
        <SettingsView />
      ) : tab.value === 'trends' ? (
        <Trends />
      ) : tab.value === 'alerts' ? (
        <AlertsView />
      ) : health === 'none' ? (
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
      ) : (
        <>
          {cantCheck && <CantCheck />}
          {health === 'partial' && <HealthStrip />}
          {!nothingActive ? (
            <>
              <InstallBanner />
              <YourRuns />
              <FilterChips />
              {list.map((bucket, i) => (
                <RunnerClassSection key={bucket.cls} bucket={bucket} headline={i === 0} />
              ))}
            </>
          ) : health === 'ok' ? (
            // The only place the page says the pools are clear, and only when
            // every repository answered.
            <section class="section">
              <div class="section-head">
                <div class="section-title">All clear</div>
                <div class="section-stats">
                  <span>All {repoCount} repositories checked</span>
                </div>
              </div>
              <div class="empty">
                No jobs are running or queued in any watched repository. Nothing is competing for
                a concurrency slot right now.
              </div>
            </section>
          ) : health === 'partial' ? (
            <section class="section">
              <div class="section-head">
                <div class="section-title">Nothing running or queued</div>
              </div>
              <div class="empty">
                Nothing is running or queued in the {answered} repositor
                {answered === 1 ? 'y' : 'ies'} that answered. The others could not be checked.
              </div>
            </section>
          ) : null}
          <RecentlyFinished />
        </>
      )}

      <Footer />
      <TabBar />
    </div>
  )
}
