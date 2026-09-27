import type { Page } from '@playwright/test'
import { PLANS } from '../src/model/plans'
import { makeJob, makeRun } from '../tests/helpers'
import { expect, test } from './fixtures'
import { dashboardSeed, REPO } from './seed'

/**
 * Does the built page start, in both its states, and hold to its policy?
 *
 * These are also the tests scripts/check-guards.mjs points at broken copies of
 * the build, by title, so a title here is part of that contract.
 */

/** Nothing on the page may be wider than the screen it is on. */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow, 'page wider than the viewport').toBeLessThanOrEqual(0)
}

test('a fresh browser lands on setup and asks GitHub nothing', async ({ page, github }) => {
  await page.goto('./')

  const token = page.getByLabel('Personal access token')
  await expect(token).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect' })).toBeDisabled()
  await token.fill('github_pat_typed')
  await expect(page.getByRole('button', { name: 'Connect' })).toBeEnabled()
  await expect(page).toHaveTitle('deliberately wrong, to prove the report is kept')
  await expectNoSidewaysScroll(page)
  expect(github.calls).toEqual([])
})

test('the manifest and its icons are served', async ({ page }) => {
  await page.goto('./')

  const href = await page.locator('link[rel="manifest"]').getAttribute('href')
  const manifestUrl = new URL(href!, page.url())
  const manifest = await page.request.get(manifestUrl.href)
  expect(manifest.status()).toBe(200)
  const { icons } = (await manifest.json()) as { icons: { src: string }[] }
  expect(icons.length).toBeGreaterThan(0)
  for (const icon of icons) {
    const response = await page.request.get(new URL(icon.src, manifestUrl).href)
    expect(response.status(), icon.src).toBe(200)
    expect(response.headers()['content-type'], icon.src).toBe('image/png')
  }
})

test('the policy refuses a connection to any other host', async ({ page, guards }) => {
  await page.goto('./')

  const outcome = await page.evaluate(() =>
    fetch('https://example.com/').then(
      () => 'connected',
      () => 'refused',
    ),
  )
  expect(outcome).toBe('refused')
  // Refused by the policy in the page, not by anything the test put in the
  // way: the guards would refuse it too, but they report it as [foreign].
  await guards.expectCspViolation({ directive: 'connect-src', blockedURI: 'https://example.com' })
})

test.describe('with a stored token', () => {
  test.use({ seed: dashboardSeed() })

  test('a stored token opens the dashboard on what GitHub reports', async ({ page, github }) => {
    github.runs(REPO, [makeRun({ id: 2, run_number: 2 })], [makeRun({ id: 1, run_number: 1, status: 'in_progress' })])
    github.jobs(1, [makeJob({ id: 11, run_id: 1, status: 'in_progress', started_at: '2026-09-09T10:01:00Z' })])
    github.jobs(2, [makeJob({ id: 21, run_id: 2 })])

    await page.goto('./')

    const counts = page.locator('.topbar-meta')
    await expect(counts.getByText('1 running', { exact: true })).toBeVisible()
    await expect(counts.getByText('1 queued', { exact: true })).toBeVisible()
    await expect(page.locator('.section-title', { hasText: /^macOS$/ })).toBeVisible()
    await expect(page.locator('[data-run="1"]')).toBeVisible()
    await expect(page.locator('[data-run="2"]')).toBeVisible()
    await expect(page).toHaveTitle(`1/${PLANS.pro.macos} macOS · 1 queued`)
    await expectNoSidewaysScroll(page)

    for (const call of github.calls) {
      expect(call.headers.accept, call.path).toBe('application/vnd.github+json')
      expect(call.headers['x-github-api-version'], call.path).toBe('2022-11-28')
    }
  })

  test('every section renders and keeps its place in the address', async ({ page, github }) => {
    github.runs(REPO, [], [])
    await page.goto('./')
    await expect(page.locator('.section-title', { hasText: 'All clear' })).toBeVisible()

    const sections = page.getByRole('navigation', { name: 'Sections' })
    const landmarks = {
      Trends: page.getByRole('group', { name: 'Range' }),
      Alerts: page.getByRole('heading', { name: 'Everyone' }),
      Settings: page.getByRole('heading', { name: 'Account' }),
      Now: page.locator('.section-title', { hasText: 'All clear' }),
    }
    for (const [name, landmark] of Object.entries(landmarks)) {
      await sections.getByRole('button', { name }).click()
      await expect(sections.getByRole('button', { name })).toHaveAttribute('aria-current', 'page')
      await expect(page).toHaveURL(new RegExp(`#${name.toLowerCase()}$`))
      await expect(landmark).toBeVisible()
      await expectNoSidewaysScroll(page)
    }

    await sections.getByRole('button', { name: 'Settings' }).click()
    await page.reload()
    await expect(landmarks.Settings).toBeVisible()
    await expect(sections.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
  })

  test('the service worker takes control without touching requests', async ({ page, github }) => {
    github.runs(REPO, [], [])
    await page.goto('./')

    const controller = () => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null)
    await expect.poll(controller, { message: 'the service worker never took control' }).toMatch(/\/sw\.js$/)

    // Once the worker controls the page, requests pass it on their way out.
    // It has no fetch handler, so they must still reach GitHub unchanged.
    const before = github.calls.length
    await page.reload()
    expect(await controller()).toMatch(/\/sw\.js$/)
    await expect.poll(() => github.calls.length).toBeGreaterThan(before)
    await expect(page.locator('.section-title', { hasText: 'All clear' })).toBeVisible()
  })
})
