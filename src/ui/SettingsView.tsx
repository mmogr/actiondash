import { PLANS, type PlanId } from '../model/plans'
import { clearJobCache, reschedule, stopPolling } from '../github/poller'
import { forgetEverything, settings, updateSettings } from '../state/settings'
import { resetData, tab, view } from '../state/store'

const INTERVALS = [
  { ms: 10_000, label: '10s' },
  { ms: 15_000, label: '15s' },
  { ms: 30_000, label: '30s' },
  { ms: 60_000, label: '60s' },
]

export function SettingsView() {
  const repoCount = settings.value.repos.length

  function onForget() {
    if (!confirm('Remove the stored token and all settings from this browser?')) return
    stopPolling()
    clearJobCache()
    resetData()
    forgetEverything()
    view.value = 'setup'
  }

  return (
    <div class="settings">
      <div class="card">
        <h2>Account</h2>
        <p>
          The plan sets the denominator on the occupancy meters. The API does not expose the
          limit, so if the guess is wrong the dashboard offers to correct it from what it sees.
        </p>
        <div class="field-row">
          <label>
            Plan{' '}
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
                  {p.label} ({p.macos} macOS, {p.total} total)
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div class="card">
        <h2>Polling</h2>
        <p>
          How often to ask GitHub. The interval stretches on its own when the hourly request
          allowance would not last until it refills. To check now, select the status at the top of
          the page.
        </p>
        <div class="field-row">
          <label>
            Refresh{' '}
            <select
              value={String(settings.value.pollIntervalMs)}
              onChange={(e) => {
                updateSettings({ pollIntervalMs: Number((e.target as HTMLSelectElement).value) })
                reschedule()
              }}
            >
              {INTERVALS.map((i) => (
                <option key={i.ms} value={String(i.ms)}>
                  {i.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div class="card">
        <h2>Repositories</h2>
        <p>
          Watching {repoCount} {repoCount === 1 ? 'repository' : 'repositories'}. Concurrency
          limits apply to the whole account, so watch every repository with active work.
        </p>
        <div class="field-row">
          <button onClick={() => (view.value = 'setup')}>Choose repositories</button>
        </div>
      </div>

      <div class="card">
        <h2>Alerts</h2>
        <p>
          Be told when a slot frees, a queued job starts or a run is superseded, while the page is
          open.
        </p>
        <div class="field-row">
          <button onClick={() => (tab.value = 'alerts')}>Alert settings</button>
        </div>
      </div>

      <div class="card">
        <h2>This browser</h2>
        <p>
          The token and every setting live in this browser's local storage and nowhere else.
          Forgetting removes all of it.
        </p>
        <div class="field-row">
          <button class="danger" onClick={onForget}>
            Forget token
          </button>
        </div>
      </div>
    </div>
  )
}
