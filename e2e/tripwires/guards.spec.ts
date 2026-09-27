import type { Page } from '@playwright/test'
import { makeJob, makeRun } from '../../tests/helpers'
import { json } from '../../tests/replies'
import { expect, test } from '../fixtures'
import { dashboardSeed, REPO, TOKEN } from '../seed'

/**
 * Every test here must fail, each on exactly the guard its title names.
 *
 * They run only when scripts/check-guards.mjs asks for them, which checks
 * that each one failed and that its failure carried its tag. A guard nobody
 * has seen fail is indistinguishable from one that cannot. Each does the one
 * wrong thing, through the same fixtures as every other test, and nothing
 * else, so the guards are checked on the path they really take.
 */

/** Gives the page a moment for an event it has already caused to arrive. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50))))
}

test('[csp] an inline script', async ({ page }) => {
  await page.goto('./')
  await page.evaluate(() => {
    const script = document.createElement('script')
    script.textContent = 'void 0'
    document.body.append(script)
  })
  await settle(page)
})

test('[pageerror] an uncaught exception', async ({ page }) => {
  await page.goto('./')
  // Not from a timer: the page's installed clock catches those and logs them,
  // which [console] reports instead.
  await page.evaluate(() => {
    queueMicrotask(() => {
      throw new Error('tripwire')
    })
  })
  await settle(page)
})

test('[console] an error in the console', async ({ page }) => {
  await page.goto('./')
  await page.evaluate(() => console.error('tripwire'))
})

test('[foreign] a request to another host', async ({ context }) => {
  // A blank page has no policy to stop it, which is the case this guard is for.
  const blank = await context.newPage()
  await blank.evaluate(() => fetch('https://example.com/').catch(() => {}))
})

test.describe('with a stored token', () => {
  test.use({ seed: dashboardSeed() })

  test('[unscripted] a request nobody scripted', async ({ page, github }) => {
    await page.goto('./')
    await expect.poll(() => github.calls.length).toBeGreaterThan(0)
  })

  test('[phantom] a row for a run GitHub never reported', async ({ page, github }) => {
    github.runs(REPO, [], [makeRun({ id: 1, status: 'in_progress' })])
    github.jobs(1, [makeJob({ run_id: 1, status: 'in_progress' })])
    await page.goto('./')
    await expect(page.locator('[data-run="1"]')).toBeVisible()
    await page.evaluate(() => {
      const row = document.createElement('div')
      row.dataset.run = '999'
      document.body.append(row)
    })
  })
})

test('[token] the token outside the Authorization header', async ({ page, github }) => {
  github.on(/\/user\?/, json({ login: 'octocat', name: null }))
  await page.goto('./')
  await page.evaluate(
    (token) => fetch(`https://api.github.com/user?t=${token}`, { headers: { Authorization: `Bearer ${token}` } }),
    TOKEN,
  )
})

test('[cors] a header GitHub does not allow', async ({ page, github }) => {
  github.user()
  await page.goto('./')
  await page.evaluate(
    (token) =>
      fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}`, 'X-Tripwire': '1' } }),
    TOKEN,
  )
})

test('[asset] a missing file of the page', async ({ page }) => {
  await page.goto('./')
  await page.evaluate(() => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = './missing.css'
    document.head.append(link)
  })
  await settle(page)
})
