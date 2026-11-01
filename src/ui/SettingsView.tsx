import { PLANS, type PlanId } from '../model/plans'
import { problemText } from '../model/health'
import { joinList, keptList } from '../model/setup'
import { repoKey } from '../github/types'
import { clearJobCache, refreshNow, reschedule, stopPolling } from '../github/poller'
import { durations } from '../state/durations'
import { graphDenied } from '../state/graphs'
import { history } from '../state/history'
import { forgetEverything, settings, updateSettings } from '../state/settings'
import { frozenAt, repoProblems, resetData, tab, view } from '../state/store'
import { shortClock } from './format'
import { seriesClass } from './palette'
import { useConfirm } from './useConfirm'

const INTERVALS = [
  { ms: 10_000, label: '10s' },
  { ms: 15_000, label: '15s' },
  { ms: 30_000, label: '30s' },
  { ms: 60_000, label: '60s' },
]

export function SettingsView() {
  const forget = useConfirm()
  const { repos, login, plan } = settings.value
  const problems = repoProblems.value
  const frozen = frozenAt.value
  // What Forget takes away, said before it does.
  const lost = [
    'the token',
    ...keptList({
      repoCount: repos.length,
      planLabel: PLANS[plan].label,
      learnedJobs: Object.keys(durations.value).length,
      hasHistory: history.value.samples.length > 0,
      graphRepos: settings.value.graphRepos.length,
    }),
  ]

  function onForget() {
    forget.done()
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
          The plan sets the ceiling on the meters, because GitHub does not report it. For macOS,
          Free, Pro and Team all allow 5 jobs at once; the plan changes only the Linux and Windows
          ceiling. If the pick is wrong, the dashboard offers to correct it from what it sees.
        </p>
        <div class="field-row">
          <label>
            Plan{' '}
            <select
              value={plan}
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
          Concurrency limits apply to the whole account, so watch every repository with active
          work.
          {frozen !== null && ` None has been checked since ${shortClock(frozen)}.`}
        </p>
        <ul class="watch-list">
          {repos.map((repo) => {
            const problem = problems.get(repoKey(repo))
            return (
              <li key={repoKey(repo)}>
                <span class={`swatch ${seriesClass(repo)}`} />
                <span class="watch-name">{repoKey(repo)}</span>
                {problem && (
                  <span class="watch-problem" title={problem.detail}>
                    not answering: {problemText(problem.problem)}, since {shortClock(problem.since)}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
        <div class="field-row">
          <button onClick={() => (view.value = 'setup')}>Edit repositories</button>
        </div>
      </div>

      <GraphsCard />

      <div class="card">
        <h2>Alerts</h2>
        <p>
          Be told when your own run starts or finishes, or about the whole pool, while the page is
          open.
        </p>
        <div class="field-row">
          <button onClick={() => (tab.value = 'alerts')}>Alert settings</button>
        </div>
      </div>

      <div class="card">
        <h2>Token</h2>
        <p>
          {login ? (
            <>
              Connected as <b>{login}</b>.{' '}
            </>
          ) : null}
          The token and every setting live in this browser's local storage and nowhere else.
        </p>
        <div class="field-row">
          <button onClick={() => (view.value = 'setup')}>Replace token</button>
          <button
            ref={forget.askRef}
            class="danger"
            onClick={forget.confirming ? forget.keep : forget.ask}
            aria-expanded={forget.confirming}
          >
            Forget token and data
          </button>
        </div>
        {forget.confirming && (
          <div class="confirm-row" role="group" aria-label="Confirm forget" onKeyDown={forget.onKeyDown}>
            <span>Remove {joinList(lost)} from this browser?</span>
            <button ref={forget.keepRef} onClick={forget.keep}>
              Keep
            </button>
            <button class="danger solid" onClick={onForget}>
              Yes, forget
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Which repositories are drawn as job graphs. Off until chosen, because a
 * graph comes from the workflow file, and reading a private repository's
 * files needs a permission that can read all of its code.
 */
function GraphsCard() {
  const { repos, graphRepos } = settings.value
  const on = new Set(graphRepos)
  const denied = graphDenied.value

  function toggle(key: string, value: boolean) {
    const next = value ? [...on, key] : [...on].filter((k) => k !== key)
    updateSettings({ graphRepos: repos.map(repoKey).filter((k) => next.includes(k)) })
    // Within the pacer's limits; otherwise the next scheduled check reads it.
    refreshNow()
  }

  return (
    <div class="card">
      <h2>Job graphs</h2>
      <p>
        Draws each run as a graph of its jobs, including the ones GitHub has not created yet, and
        says when the whole run should finish. The graph comes from the run's workflow file.
      </p>
      <p class="hint">
        Reading the workflow file of a private repository needs <b>Contents: read</b> on the token.
        That permission can read all of the repository's code. The dashboard uses it only for the
        files in <code>.github/workflows/</code>, and an unchanged file costs nothing to check again.
      </p>
      <ul class="watch-list">
        {repos.map((repo) => {
          const key = repoKey(repo)
          const problem = denied.get(key)
          return (
            <li key={key}>
              <label class="graph-toggle">
                <input
                  type="checkbox"
                  checked={on.has(key)}
                  onChange={(e) => toggle(key, (e.target as HTMLInputElement).checked)}
                />
                <span class={`swatch ${seriesClass(repo)}`} />
                <span class="watch-name">{key}</span>
              </label>
              {on.has(key) && problem && (
                <span class="watch-problem" title={problem}>
                  cannot read its workflow files: the token needs Contents: read
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
