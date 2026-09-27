import type { RepoRef } from '../src/github/types'
import type { Settings } from '../src/state/settings'

/**
 * What a browser test starts from: the time on the page's clock, the tokens it
 * may send, and what is already in localStorage when the page first loads.
 *
 * The storage keys are written out here rather than imported, because the
 * modules that own them read localStorage as soon as they load.
 */

/** The only credentials a test may send. Neither may appear anywhere else. */
export const TOKEN = 'github_pat_E2E_SENTINEL_must_not_leak_0123456789'
export const NEW_TOKEN = 'github_pat_E2E_REPLACEMENT_must_not_leak_98765'

/** Five minutes after the runs from tests/helpers.ts were created. */
export const FIXED_NOW = new Date('2026-09-09T10:05:00Z')

export const REPO: RepoRef = { owner: 'acme', name: 'app' }

export const KEYS = {
  settings: 'actiondash.settings.v1',
  durations: 'actiondash.durations.v1',
  history: 'actiondash.history.v1',
} as const

type StoredSettings = Partial<Settings> & { observedEpoch?: number }

export interface Seed {
  settings?: StoredSettings
  durations?: unknown
  history?: unknown
}

/** A browser that has already been set up: a token, one repository, the Pro plan. */
export function dashboardSeed(over: StoredSettings = {}): Seed {
  return {
    settings: { token: TOKEN, repos: [REPO], plan: 'pro', login: 'octocat', observedEpoch: 2, ...over },
  }
}

/**
 * The seed as Playwright storage state. It is applied once, when the browser
 * context is made, so a test that clears storage and reloads sees it cleared.
 */
export function storageStateFor(seed: Seed, origin: string) {
  const localStorage = Object.entries(seed)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ name: KEYS[key as keyof Seed], value: JSON.stringify(value) }))
  return { cookies: [], origins: [{ origin, localStorage }] }
}
