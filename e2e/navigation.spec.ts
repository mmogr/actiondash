import type { RepoRef } from '../src/github/types'
import { makeJob, makeRun } from '../tests/helpers'
import { expect, test } from './fixtures'
import { dashboardSeed, REPO } from './seed'

/**
 * Getting around: the sections in the address, and links to one run, which is
 * what a notification opens.
 */

const SITE: RepoRef = { owner: 'acme', name: 'site' }

test.describe('with one repository', () => {
  test.use({ seed: dashboardSeed() })

  test('a link to a run scrolls to its row, focuses it and marks it briefly', async ({ page, github }) => {
    const runs = Array.from({ length: 12 }, (_, i) => makeRun({ id: i + 1, run_number: i + 1 }))
    github.runs(REPO, runs, [])
    for (const run of runs) github.jobs(run.id, [makeJob({ id: 100 + run.id, run_id: run.id })])
    await page.goto('./#run=12')

    const row = page.locator('[data-run="12"]')
    await expect(row).toHaveClass(/\bis-flash\b/)
    await expect(row.getByRole('button', { name: 'Jobs of app #12' })).toBeFocused()
    await expect(row).toBeInViewport()
    // Below the first screenful, so being in view means the page scrolled to it.
    const top = await row.evaluate((el) => el.getBoundingClientRect().top + window.scrollY)
    expect(top).toBeGreaterThan(page.viewportSize()!.height)
    await expect(page).toHaveURL(/#now$/)

    await page.clock.fastForward(2_000)
    await expect(page.locator('.is-flash')).toHaveCount(0)
  })

  test('an address the page does not recognise opens the Now tab', async ({ page, github }) => {
    github.runs(REPO, [], [])
    await page.goto('./#bogus')

    const sections = page.getByRole('navigation', { name: 'Sections' })
    await expect(sections.getByRole('button', { name: 'Now' })).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('.section-title', { hasText: /^All clear$/ })).toBeVisible()
    await expect(page).toHaveURL(/#now$/)
  })

  test('a link to a run that is no longer listed lands on Now and leaves the address working', async ({
    page,
    github,
  }) => {
    github.runs(REPO, [], [])
    await page.goto('./#run=999')

    const sections = page.getByRole('navigation', { name: 'Sections' })
    await expect(page.locator('.section-title', { hasText: /^All clear$/ })).toBeVisible()
    await expect(page).toHaveURL(/#now$/)
    // A run still waiting to be shown holds the address still; this one must
    // have been let go, or the address would stop following the sections.
    await sections.getByRole('button', { name: 'Trends' }).click()
    await expect(page).toHaveURL(/#trends$/)
  })

  test('switching sections replaces the address, so Back leaves the page rather than stepping through them', async ({
    page,
    github,
    baseURL,
  }) => {
    github.runs(REPO, [], [])
    await page.goto('./')
    await expect(page.locator('.section-title', { hasText: /^All clear$/ })).toBeVisible()
    const length = await page.evaluate(() => history.length)

    const sections = page.getByRole('navigation', { name: 'Sections' })
    for (const name of ['Trends', 'Alerts', 'Settings', 'Now', 'Trends']) {
      await sections.getByRole('button', { name }).click()
      await expect(page).toHaveURL(new RegExp(`#${name.toLowerCase()}$`))
    }
    expect(await page.evaluate(() => history.length)).toBe(length)

    await page.goBack()
    expect(page.url().startsWith(baseURL!)).toBe(false)
  })

  test('a section reached through the address follows Back and Forward', async ({ page, github }) => {
    github.runs(REPO, [], [])
    await page.goto('./')
    const sections = page.getByRole('navigation', { name: 'Sections' })
    const now = sections.getByRole('button', { name: 'Now' })
    const alerts = sections.getByRole('button', { name: 'Alerts' })
    await expect(page.locator('.section-title', { hasText: /^All clear$/ })).toBeVisible()

    // As following a link to it, or typing it into the address bar, would.
    await page.evaluate(() => {
      location.hash = '#alerts'
    })
    await expect(alerts).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('heading', { name: 'Everyone' })).toBeVisible()

    await page.goBack()
    await expect(now).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('.section-title', { hasText: /^All clear$/ })).toBeVisible()

    await page.goForward()
    await expect(alerts).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('heading', { name: 'Everyone' })).toBeVisible()
  })
})

test.describe('with two repositories', () => {
  test.use({ seed: dashboardSeed({ repos: [REPO, SITE] }) })

  test('following Show in list from Your runs clears the filter that hid the run', async ({ page, github }) => {
    const mine = makeRun({ id: 1, run_number: 7, actor: { login: 'octocat' } })
    const theirs = makeRun({ id: 2, run_number: 3, repoName: 'site', actor: { login: 'hubot' } })
    github.runs(REPO, [mine], []).runs(SITE, [theirs], [])
    github.jobs(1, [makeJob({ id: 11, run_id: 1 })])
    github.jobs(2, [makeJob({ id: 21, run_id: 2 })])
    await page.goto('./')

    const chips = page.getByRole('group', { name: 'Show' })
    const all = chips.getByRole('button', { name: 'All', exact: true })
    const site = chips.getByRole('button', { name: 'site', exact: true })
    const row = page.locator('[data-run="1"]')
    await expect(row).toBeVisible()
    await site.click()
    await expect(site).toHaveAttribute('aria-pressed', 'true')
    await expect(row).toHaveCount(0)
    await expect(page.locator('[data-run="2"]')).toBeVisible()

    await page.getByRole('region', { name: 'Your runs' }).getByRole('link', { name: 'Show in list' }).click()

    await expect(all).toHaveAttribute('aria-pressed', 'true')
    await expect(site).toHaveAttribute('aria-pressed', 'false')
    await expect(row).toBeVisible()
    await expect(row).toHaveClass(/\bis-flash\b/)
    await expect(row.getByRole('button', { name: 'Jobs of app #7' })).toBeFocused()
    await expect(page).toHaveURL(/#now$/)
  })
})
