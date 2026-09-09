import { signal } from '@preact/signals'
import type { RepoRef } from '../github/types'
import type { ObservedMax, PlanId } from '../model/plans'
import { clearCache, setTokenProvider } from '../github/client'

/**
 * Persisted configuration, including the GitHub token.
 *
 * The token lives in localStorage and nowhere else. It is never placed in the
 * URL, never logged, and never rendered back into the DOM. Combined with the
 * Content Security Policy, which permits connections to api.github.com alone,
 * and with the origin guard in the API client, there is no path by which it
 * reaches a third party.
 */

const STORAGE_KEY = 'actiondash.settings.v1'

export interface Settings {
  token: string | null
  repos: RepoRef[]
  plan: PlanId
  pollIntervalMs: number
  /**
   * The most jobs ever seen running at once per runner class. Used to tell the
   * user when their chosen plan cannot explain what the account is doing.
   */
  observedMax: ObservedMax
}

const DEFAULTS: Settings = {
  token: null,
  repos: [],
  plan: 'free',
  pollIntervalMs: 15_000,
  observedMax: {},
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<Settings>
    return {
      token: typeof parsed.token === 'string' ? parsed.token : null,
      repos: Array.isArray(parsed.repos) ? parsed.repos.filter(isRepoRef) : [],
      plan: isPlanId(parsed.plan) ? parsed.plan : DEFAULTS.plan,
      pollIntervalMs:
        typeof parsed.pollIntervalMs === 'number' && parsed.pollIntervalMs >= 5_000
          ? parsed.pollIntervalMs
          : DEFAULTS.pollIntervalMs,
      observedMax:
        parsed.observedMax && typeof parsed.observedMax === 'object'
          ? sanitiseObserved(parsed.observedMax)
          : {},
    }
  } catch {
    // Private browsing, disabled site data, or corrupt JSON. Start clean.
    return { ...DEFAULTS }
  }
}

/** Keeps only finite, positive counts, so corrupt storage cannot skew a meter. */
function sanitiseObserved(raw: Record<string, unknown>): ObservedMax {
  const out: ObservedMax = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      out[key as keyof ObservedMax] = Math.floor(value)
    }
  }
  return out
}

function isRepoRef(v: unknown): v is RepoRef {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as RepoRef).owner === 'string' &&
    typeof (v as RepoRef).name === 'string'
  )
}

function isPlanId(v: unknown): v is PlanId {
  return v === 'free' || v === 'pro' || v === 'team' || v === 'enterprise'
}

export const settings = signal<Settings>(load())

/**
 * A token being validated on the setup screen, before it is trusted enough to
 * persist. The API client prefers it so that validation requests authenticate
 * without writing an unverified token to storage.
 */
export const pendingToken = signal<string | null>(null)

function persist(next: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage unavailable. The session still works, it just will not survive a
    // reload, which is an acceptable degradation for a token-holding page.
  }
}

export function updateSettings(patch: Partial<Settings>): void {
  const next = { ...settings.value, ...patch }
  settings.value = next
  persist(next)
}

/** Wipes the token and every other stored value, and drops cached API data. */
export function forgetEverything(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to remove.
  }
  settings.value = { ...DEFAULTS }
  clearCache()
}

// The API client reads the token through this provider so that it never has to
// import application state, which keeps the module free of circular imports.
setTokenProvider(() => pendingToken.value ?? settings.value.token)

export type TokenKind = 'fine-grained' | 'classic' | 'oauth' | 'unknown'

/**
 * Classifies a token by prefix so the setup screen can steer the user towards a
 * fine-grained token, which is the only kind that can be scoped to a chosen set
 * of repositories.
 */
export function tokenKind(token: string): TokenKind {
  if (token.startsWith('github_pat_')) return 'fine-grained'
  if (token.startsWith('ghp_')) return 'classic'
  if (token.startsWith('gho_') || token.startsWith('ghu_')) return 'oauth'
  return 'unknown'
}
