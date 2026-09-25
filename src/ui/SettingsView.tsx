import { useState } from 'preact/hooks'
import { PLANS, type PlanId } from '../model/plans'
import { distinctRuns } from '../model/queue'
import { cancelRun } from '../github/api'
import { clearJobCache, pollOnce, stopPolling } from '../github/poller'
import { forgetEverything, settings, updateSettings } from '../state/settings'
import { resetData, stale, view, warning } from '../state/store'

const INTERVALS = [
  { ms: 10_000, label: '10s' },
  { ms: 15_000, label: '15s' },
  { ms: 30_000, label: '30s' },
  { ms: 60_000, label: '60s' },
]

export function SettingsView() {
  const [cancelling, setCancelling] = useState(false)
  const staleRuns = distinctRuns(stale.value)
  const repoCount = settings.value.repos.length

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
          allowance would not last until it refills.
        </p>
        <div class="field-row">
          <label>
            Refresh{' '}
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
          <button onClick={() => void pollOnce()}>Refresh now</button>
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

      {staleRuns.length > 0 && (
        <div class="card">
          <h2>Superseded runs</h2>
          <p>
            {staleRuns.length} {staleRuns.length === 1 ? 'run has' : 'runs have'} been replaced by a
            newer commit on the same branch and {staleRuns.length === 1 ? 'is' : 'are'} still
            holding or waiting for a slot.
          </p>
          <div class="field-row">
            <button class="danger" onClick={cancelAllStale} disabled={cancelling}>
              {cancelling
                ? 'Cancelling...'
                : `Cancel ${staleRuns.length} superseded run${staleRuns.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}

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
