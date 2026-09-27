import { test as base, expect } from '@playwright/test'
import { BrowserGitHub } from './github'
import { Guards } from './guards'
import { FIXED_NOW, storageStateFor, type Seed } from './seed'

/**
 * The browser tests' test() and expect().
 *
 * Every test gets a page whose clock starts at a fixed moment and then runs
 * normally, a scripted GitHub, and the guards, whether it asks for them or
 * not. Script GitHub first, then load the page.
 */

interface Options {
  /** What is in localStorage before the first load; null for a new visitor. */
  seed: Seed | null
  /** When the page's clock starts. */
  clockAt: Date
}

interface Fixtures {
  github: BrowserGitHub
  guards: Guards
}

export const test = base.extend<Options & Fixtures>({
  seed: [null, { option: true }],
  clockAt: [FIXED_NOW, { option: true }],

  storageState: async ({ seed, baseURL }, use) => {
    await use(seed ? storageStateFor(seed, new URL(baseURL!).origin) : undefined)
  },

  page: async ({ page, clockAt }, use) => {
    // Installed, not paused: the app's effects and timers run as they would,
    // and a test moves time on with page.clock when it needs to.
    await page.clock.install({ time: clockAt })
    await use(page)
  },

  github: async ({ context, clockAt }, use) => {
    const github = new BrowserGitHub(Math.floor(clockAt.getTime() / 1000) + 3600)
    await github.attach(context)
    await use(github)
    await context.unrouteAll({ behavior: 'ignoreErrors' })
  },

  guards: [
    async ({ context, page, github, baseURL }, use, testInfo) => {
      const guards = new Guards(new URL(baseURL!).origin, github)
      await guards.attach(context, page)
      await use(guards)
      await guards.verify(context, testInfo)
    },
    { auto: true },
  ],
})

export { expect }
