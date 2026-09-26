import { afterEach, describe, expect, it, vi } from 'vitest'
import { OBSERVED_EPOCH } from '../src/state/settings'

const KEY = 'actiondash.settings.v1'

function fakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
  }
}

/** settings.ts reads storage at import time, so each case needs a fresh one. */
async function loadWith(stored: Record<string, unknown>) {
  const storage = fakeStorage()
  storage.map.set(KEY, JSON.stringify(stored))
  vi.stubGlobal('localStorage', storage)
  vi.resetModules()
  return { storage, mod: await import('../src/state/settings') }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('stored observations', () => {
  const PAYLOAD = {
    token: 'github_pat_secret',
    repos: [{ owner: 'acme', name: 'app' }],
    plan: 'pro',
    pollIntervalMs: 30_000,
    observedMax: { macos: 8, total: 8 },
  }

  it('drops observations written before the epoch, keeping everything else', async () => {
    // The eight that told a Pro account it must be on Enterprise was written by
    // a version that counted duplicated runs. Rotating the storage key would
    // clear it too, at the cost of making the reader authenticate again.
    const { mod } = await loadWith(PAYLOAD)

    expect(mod.settings.value.observedMax).toEqual({})
    expect(mod.settings.value.token).toBe('github_pat_secret')
    expect(mod.settings.value.repos).toEqual([{ owner: 'acme', name: 'app' }])
    expect(mod.settings.value.plan).toBe('pro')
    expect(mod.settings.value.pollIntervalMs).toBe(30_000)
  })

  it('drops observations stamped with an older epoch', async () => {
    const { mod } = await loadWith({ ...PAYLOAD, observedEpoch: OBSERVED_EPOCH - 1 })

    expect(mod.settings.value.observedMax).toEqual({})
  })

  it('keeps observations written at the current epoch', async () => {
    const { mod } = await loadWith({
      ...PAYLOAD,
      observedMax: { macos: 4, total: 9 },
      observedEpoch: OBSERVED_EPOCH,
    })

    expect(mod.settings.value.observedMax).toEqual({ macos: 4, total: 9 })
  })

  it('stamps the epoch on the next write', async () => {
    const { mod, storage } = await loadWith(PAYLOAD)

    mod.updateSettings({ plan: 'team' })

    const written = JSON.parse(storage.map.get(KEY)!)
    expect(written.observedEpoch).toBe(OBSERVED_EPOCH)
    expect(written.plan).toBe('team')
  })
})

describe('a rejected token', () => {
  it('is remembered as a time, and anything else reads as not rejected', async () => {
    expect((await loadWith({ tokenRejectedAt: 1_789_000_000_000 })).mod.settings.value.tokenRejectedAt).toBe(
      1_789_000_000_000,
    )
    expect((await loadWith({ tokenRejectedAt: 'yesterday' })).mod.settings.value.tokenRejectedAt).toBeNull()
    expect((await loadWith({})).mod.settings.value.tokenRejectedAt).toBeNull()
  })
})

describe('the stored login', () => {
  it('is kept when it is a name, and dropped otherwise', async () => {
    expect((await loadWith({ login: 'dana-k' })).mod.settings.value.login).toBe('dana-k')
    expect((await loadWith({ login: 42 })).mod.settings.value.login).toBeNull()
    expect((await loadWith({ login: '' })).mod.settings.value.login).toBeNull()
    expect((await loadWith({})).mod.settings.value.login).toBeNull()
  })
})
