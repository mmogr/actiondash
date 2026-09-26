import { useEffect, useState } from 'preact/hooks'
import { getUser, listRepos, probeRepos } from '../github/api'
import { GitHubError } from '../github/client'
import { clearJobCache } from '../github/poller'
import { parseRepo, repoKey, type Repo, type RepoRef } from '../github/types'
import { classify, problemText } from '../model/health'
import { PLANS, type PlanId } from '../model/plans'
import { joinList, keptList, ownersOf, sameAccount, sameSelection } from '../model/setup'
import { durations } from '../state/durations'
import { history } from '../state/history'
import { pendingToken, settings, tokenKind, updateSettings } from '../state/settings'
import { fatalError, resetData, view } from '../state/store'
import { shortClock } from './format'

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new'
const TOKENS_URL = 'https://github.com/settings/personal-access-tokens'

/** "acme/site: not found; the token may not include it". */
function unreadableText(failures: readonly { repo: RepoRef; error: unknown }[]): string {
  return failures.map((f) => `${repoKey(f.repo)}: ${problemText(classify(f.error))}`).join('; ')
}

/** Everything a fresh start needs, once a token and its repositories check out. */
function enterDashboard(): void {
  pendingToken.value = null
  clearJobCache()
  resetData()
  fatalError.value = null
  view.value = 'dashboard'
}

export function Setup() {
  const stored = settings.value.token
  const rejectedAt = settings.value.tokenRejectedAt
  const [tokenInput, setTokenInput] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [connectedAs, setConnectedAs] = useState<string | null>(null)
  const [repos, setRepos] = useState<Repo[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(settings.value.repos.map(repoKey)),
  )
  const [filter, setFilter] = useState('')
  const [manual, setManual] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Repositories the last check could not read, and why, shown by Open.
  const [unreadable, setUnreadable] = useState<{ keys: string[]; text: string } | null>(null)

  const kind = tokenInput ? tokenKind(tokenInput) : null

  // A stored token that GitHub has not rejected is checked straight away, so
  // the repository list is there without a click.
  useEffect(() => {
    if (stored && rejectedAt === null) void connect(stored)
  }, [])

  async function connect(token: string) {
    setBusy(true)
    setError(null)
    setNotice(null)
    pendingToken.value = token
    try {
      const user = await getUser()
      setConnectedAs(user.login)
      // Drop the secret from the input as soon as it is validated, so it stops
      // living in the DOM where a screenshot or accessibility tree exposes it.
      setTokenInput('')
      const list = await listRepos()
      setRepos(list)
      if (list.length === 0) {
        setNotice(
          'The token reached GitHub but reported no repositories. Add repositories to it, or enter one below by name.',
        )
      }
    } catch (err) {
      pendingToken.value = null
      setConnectedAs(null)
      if (err instanceof GitHubError && err.status === 401) {
        setError('GitHub rejected that token. Check it was copied whole and has not expired.')
      } else {
        setError((err as Error).message)
      }
    } finally {
      setBusy(false)
    }
  }

  /**
   * After a rejection: a new token for the same account that can still read
   * every watched repository goes straight back to the dashboard. Anything
   * else falls through to choosing repositories again.
   */
  async function reconnect(token: string) {
    setBusy(true)
    setError(null)
    pendingToken.value = token
    try {
      const user = await getUser()
      setTokenInput('')
      if (sameAccount(settings.value.login, user.login)) {
        const failures = await probeRepos(settings.value.repos)
        if (failures.length === 0) {
          updateSettings({ token, login: user.login, tokenRejectedAt: null })
          enterDashboard()
          return
        }
        setUnreadable({ keys: failures.map((f) => repoKey(f.repo)), text: unreadableText(failures) })
      }
      setConnectedAs(user.login)
      setRepos(await listRepos())
    } catch (err) {
      pendingToken.value = null
      setError(
        err instanceof GitHubError && err.status === 401
          ? 'GitHub rejected that token too. Check it was copied whole.'
          : (err as Error).message,
      )
    } finally {
      setBusy(false)
    }
  }

  function toggle(key: string) {
    const next = new Set(selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setSelected(next)
  }

  function addManual() {
    const ref = parseRepo(manual)
    if (!ref) {
      setError('Enter a repository as owner/name.')
      return
    }
    setError(null)
    setSelected(new Set([...selected, repoKey(ref)]))
    setManual('')
  }

  async function start() {
    const refs: RepoRef[] = [...selected]
      .map(parseRepo)
      .filter((r): r is RepoRef => r !== null)

    if (refs.length === 0) {
      setError('Select at least one repository.')
      return
    }

    setBusy(true)
    setError(null)
    setUnreadable(null)
    const token = pendingToken.value ?? stored
    try {
      // Every repository, not just the first: a typo or one missing from the
      // token would otherwise surface later as a warning on the dashboard.
      const failures = await probeRepos(refs)
      if (failures.length > 0) {
        setUnreadable({ keys: failures.map((f) => repoKey(f.repo)), text: unreadableText(failures) })
        return
      }
      // The ceiling belongs to the account that owns the repositories, so a
      // peak measured over one set of owners is no evidence about another. A
      // repository added under an owner already watched leaves it standing.
      const owners = (list: readonly RepoRef[]): string =>
        [...new Set(list.map((r) => r.owner))].sort().join(',')
      const ownersChanged = owners(settings.value.repos) !== owners(refs)
      updateSettings({
        token,
        repos: refs,
        tokenRejectedAt: null,
        ...(connectedAs ? { login: connectedAs } : {}),
        ...(ownersChanged ? { observedMax: {} } : {}),
      })
      enterDashboard()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const visible = (repos ?? []).filter((r) =>
    filter ? r.full_name.toLowerCase().includes(filter.toLowerCase()) : true,
  )
  const owners = ownersOf(selected)
  const canGoBack = stored !== null && rejectedAt === null && settings.value.repos.length > 0
  const changed =
    !sameSelection(settings.value.repos, selected) ||
    (pendingToken.value !== null && pendingToken.value !== stored)
  const kept = keptList({
    repoCount: settings.value.repos.length,
    planLabel: PLANS[settings.value.plan].label,
    learnedJobs: Object.keys(durations.value).length,
    hasHistory: history.value.samples.length > 0,
  })

  const tokenField = (onSubmit: (token: string) => void, label: string) => (
    <div class="field-row">
      <input
        type="password"
        autocomplete="off"
        spellcheck={false}
        placeholder="github_pat_..."
        aria-label="Personal access token"
        value={tokenInput}
        onInput={(e) => setTokenInput((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && tokenInput.trim()) onSubmit(tokenInput.trim())
        }}
      />
      <button
        class="primary"
        disabled={busy || tokenInput.trim().length === 0}
        onClick={() => onSubmit(tokenInput.trim())}
      >
        {busy ? 'Checking...' : label}
      </button>
    </div>
  )

  return (
    <div class="shell setup">
      <div class="topbar">
        <div class="brand">
          actiondash <span>/ setup</span>
        </div>
        {canGoBack && (
          <button
            onClick={() => {
              pendingToken.value = null
              view.value = 'dashboard'
            }}
          >
            {changed ? 'Discard changes' : 'Back to dashboard'}
          </button>
        )}
      </div>

      {fatalError.value && rejectedAt === null && (
        <div class="banner error" role="alert">
          {fatalError.value}
        </div>
      )}

      {rejectedAt !== null ? (
        <div class="card recovery">
          <h2>Your GitHub token stopped working</h2>
          <p>
            GitHub rejected it at {shortClock(rejectedAt)}. Fine-grained tokens expire, so that is
            the usual reason; a revoked token looks the same.
          </p>
          <ol class="steps">
            <li>
              <a href={TOKENS_URL} target="_blank" rel="noreferrer noopener">
                Regenerate it on GitHub ↗
              </a>
              . Regenerating keeps its permissions and repositories.
            </li>
            <li>
              Paste the new token here.
              {tokenField((t) => void reconnect(t), 'Reconnect')}
            </li>
          </ol>
          <p class="hint">Kept in this browser: {joinList(kept)}.</p>
          {connectedAs && (
            <div class="hint good">Connected as {connectedAs}. Choose repositories below.</div>
          )}
          {error && <div class="hint bad">{error}</div>}
        </div>
      ) : (
        <div class="card">
          <h2>1. Personal access token</h2>
          <p>
            The token is held in this browser only. A strict Content Security Policy on this page
            permits network connections to api.github.com and to nothing else, so the token cannot
            be sent anywhere but GitHub.
          </p>

          <p>
            Create a <b>fine-grained</b> token at{' '}
            <a href={TOKEN_URL} target="_blank" rel="noreferrer noopener">
              github.com/settings/personal-access-tokens/new
            </a>{' '}
            with:
          </p>
          <ul class="perm-list">
            <li>
              <b>Repository access:</b> only the repositories you want to watch
            </li>
            <li>
              <b>Actions:</b> Read and write, which covers reading the queue and cancelling a run
            </li>
            <li>
              <b>Metadata:</b> Read, which GitHub adds automatically
            </li>
            <li>Nothing else. No Contents, no Pull requests, no Workflows.</li>
          </ul>

          {stored && !connectedAs && !replacing ? (
            <div class="field-row">
              <button class="primary" onClick={() => void connect(stored)} disabled={busy}>
                {busy ? 'Checking...' : 'Use stored token'}
              </button>
              <button onClick={() => setReplacing(true)} disabled={busy}>
                Replace it
              </button>
            </div>
          ) : (
            <>
              {tokenField((t) => void connect(t), 'Connect')}
              {replacing && stored && !connectedAs && (
                <button
                  class="link"
                  onClick={() => {
                    setReplacing(false)
                    setTokenInput('')
                  }}
                >
                  Keep the saved token
                </button>
              )}

              {kind === 'classic' && (
                <div class="hint bad">
                  That is a classic token. Classic tokens carry the repo scope across every
                  repository you can reach. A fine-grained token restricted to the repositories you
                  actually watch is strongly preferred.
                </div>
              )}
              {kind === 'oauth' && (
                <div class="hint bad">
                  That looks like an OAuth or CLI token, for example one from gh auth. Create a
                  fine-grained personal access token instead.
                </div>
              )}
              {kind === 'fine-grained' && <div class="hint good">Fine-grained token.</div>}
            </>
          )}

          {connectedAs && <div class="hint good">Connected as {connectedAs}.</div>}
          {error && <div class="hint bad">{error}</div>}
          {notice && <div class="hint">{notice}</div>}
        </div>
      )}

      {connectedAs && (
        <div class="card">
          <h2>{rejectedAt === null ? '2. ' : ''}Repositories to watch</h2>
          <p>
            Concurrency limits apply to your whole account, so watching every repository with
            active work gives the only accurate picture of what is competing for slots.
          </p>

          <div class="toolbar">
            <input
              type="text"
              placeholder="Filter"
              aria-label="Filter repositories"
              value={filter}
              onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
            />
            <button onClick={() => setSelected(new Set([...selected, ...visible.map((r) => r.full_name)]))}>
              Select all shown
            </button>
            <button onClick={() => setSelected(new Set())}>Clear</button>
          </div>

          {visible.length > 0 && (
            <div class="repo-list">
              {visible.map((repo) => (
                <label class="repo-item" key={repo.full_name}>
                  <input
                    type="checkbox"
                    checked={selected.has(repo.full_name)}
                    onChange={() => toggle(repo.full_name)}
                  />
                  <span class="name">{repo.full_name}</span>
                  <span class="tag">{repo.private ? 'private' : 'public'}</span>
                </label>
              ))}
            </div>
          )}

          <div class="toolbar">
            <input
              type="text"
              placeholder="Or add by name: owner/repo"
              aria-label="Add a repository by name"
              value={manual}
              onInput={(e) => setManual((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addManual()
              }}
            />
            <button onClick={addManual}>Add</button>
          </div>

          {owners.length > 1 && (
            <div class="banner warn">
              <span>
                These repositories belong to {owners.length} accounts:{' '}
                {joinList(owners.map((o) => o.owner))}. GitHub meters each account's slots
                separately, so the meters would add up pools that never compete. Watch one account
                at a time.
              </span>
              <div class="banner-actions">
                <button
                  onClick={() =>
                    setSelected(new Set([...selected].filter((k) => k.split('/')[0] === owners[0]!.owner)))
                  }
                >
                  Keep only {owners[0]!.owner}
                </button>
              </div>
            </div>
          )}

          <div class="hint">
            {selected.size} selected
            {selected.size > 0 ? `: ${[...selected].join(', ')}` : ''}
          </div>
        </div>
      )}

      {connectedAs && (
        <div class="card">
          <h2>{rejectedAt === null ? '3. ' : ''}Start</h2>
          <p>
            Pick the plan of the account that owns these repositories. It sets the ceiling on the
            meters, because GitHub does not report it. For macOS, Free, Pro and Team all allow 5
            jobs at once, so the choice only matters for Linux and Windows. If the pick is wrong,
            the dashboard can often tell from what it sees running, and offers to correct it.
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
                {Object.values(PLANS).map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.label} ({plan.macos} macOS, {plan.total} total)
                  </option>
                ))}
              </select>
            </label>
            <button class="primary" onClick={() => void start()} disabled={busy}>
              {busy ? 'Checking each repository...' : 'Open dashboard'}
            </button>
          </div>
          {unreadable && (
            <div class="hint bad" role="alert">
              The token cannot read Actions on {unreadable.text}. Grant it Actions: Read and write,
              and make sure each repository is in its access list.{' '}
              <button
                class="link"
                onClick={() => {
                  setSelected(new Set([...selected].filter((k) => !unreadable.keys.includes(k))))
                  setUnreadable(null)
                }}
              >
                Deselect {unreadable.keys.length === 1 ? 'it' : 'these'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
