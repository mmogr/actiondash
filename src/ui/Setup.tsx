import { useState } from 'preact/hooks'
import { getUser, listRepos, probeActionsAccess } from '../github/api'
import { GitHubError } from '../github/client'
import { parseRepo, repoKey, type Repo, type RepoRef } from '../github/types'
import { pendingToken, settings, tokenKind, updateSettings } from '../state/settings'
import { PLANS, type PlanId } from '../model/plans'
import { fatalError, resetData, view } from '../state/store'
import { clearJobCache } from '../github/poller'

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new'

export function Setup() {
  const stored = settings.value.token
  const [tokenInput, setTokenInput] = useState('')
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

  const kind = tokenInput ? tokenKind(tokenInput) : null

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
    const next = new Set(selected)
    next.add(repoKey(ref))
    setSelected(next)
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
    const token = pendingToken.value ?? stored
    try {
      await probeActionsAccess(refs[0]!)
      // The ceiling belongs to the account that owns the repositories, so a
      // peak measured over one set of owners is no evidence about another. A
      // repository added under an owner already watched leaves it standing.
      const ownersOf = (list: readonly RepoRef[]): string =>
        [...new Set(list.map((r) => r.owner))].sort().join(',')
      const ownersChanged = ownersOf(settings.value.repos) !== ownersOf(refs)
      updateSettings({
        token,
        repos: refs,
        ...(connectedAs ? { login: connectedAs } : {}),
        ...(ownersChanged ? { observedMax: {} } : {}),
      })
      pendingToken.value = null
      clearJobCache()
      resetData()
      fatalError.value = null
      view.value = 'dashboard'
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 403 || err.status === 404)) {
        setError(
          `The token cannot read Actions on ${repoKey(refs[0]!)}. ` +
            'Grant it Actions: Read and write, and make sure that repository is in its access list.',
        )
      } else {
        setError((err as Error).message)
      }
    } finally {
      setBusy(false)
    }
  }

  const visible = (repos ?? []).filter((r) =>
    filter ? r.full_name.toLowerCase().includes(filter.toLowerCase()) : true,
  )

  return (
    <div class="shell setup">
      <div class="topbar">
        <div class="brand">
          actiondash <span>/ setup</span>
        </div>
        {settings.value.repos.length > 0 && (
          <button onClick={() => (view.value = 'dashboard')}>Back to dashboard</button>
        )}
      </div>

      {fatalError.value && <div class="banner error">{fatalError.value}</div>}

      <div class="card">
        <h2>1. Personal access token</h2>
        <p>
          The token is held in this browser only. A strict Content Security Policy on this page
          permits network connections to api.github.com and to nothing else, so the token cannot be
          sent anywhere but GitHub.
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

        {stored && !connectedAs ? (
          <div class="field-row">
            <button class="primary" onClick={() => void connect(stored)} disabled={busy}>
              {busy ? 'Checking...' : 'Use stored token'}
            </button>
            <button onClick={() => updateSettings({ token: null })} disabled={busy}>
              Replace it
            </button>
          </div>
        ) : (
          <>
            <div class="field-row">
              <input
                type="password"
                autocomplete="off"
                spellcheck={false}
                placeholder="github_pat_..."
                value={tokenInput}
                onInput={(e) => setTokenInput((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && tokenInput.trim()) void connect(tokenInput.trim())
                }}
              />
              <button
                class="primary"
                disabled={busy || tokenInput.trim().length === 0}
                onClick={() => void connect(tokenInput.trim())}
              >
                {busy ? 'Checking...' : 'Connect'}
              </button>
            </div>

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

      {connectedAs && (
        <div class="card">
          <h2>2. Repositories to watch</h2>
          <p>
            Concurrency limits apply to your whole account, so watching every repository with
            active work gives the only accurate picture of what is competing for slots.
          </p>

          <div class="toolbar">
            <input
              type="text"
              placeholder="Filter"
              value={filter}
              onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
            />
            <button onClick={() => setSelected(new Set(visible.map((r) => r.full_name)))}>
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
              value={manual}
              onInput={(e) => setManual((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addManual()
              }}
            />
            <button onClick={addManual}>Add</button>
          </div>

          <div class="hint">
            {selected.size} selected
            {selected.size > 0 ? `: ${[...selected].join(', ')}` : ''}
          </div>
        </div>
      )}

      {connectedAs && (
        <div class="card">
          <h2>3. Start</h2>
          <p>
            Pick the plan that applies to the account owning these repositories. It sets the
            denominator on the occupancy meters. The API does not expose the limit at all, so if
            the guess is wrong the dashboard may be able to tell from what it sees running, and
            will offer to correct it. Watch one owner's repositories at a time: pools belonging
            to different accounts are metered separately.
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
              {busy ? 'Checking access...' : 'Open dashboard'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
