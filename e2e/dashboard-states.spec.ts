import { runsQuery } from '../src/github/queries'
import type { RepoRef } from '../src/github/types'
import { PLANS } from '../src/model/plans'
import { makeJob, makeRun } from '../tests/helpers'
import { deferred, json, networkError } from '../tests/replies'
import { expect, test } from './fixtures'
import { LISTINGS } from './scenarios'
import { dashboardSeed, FIXED_NOW, REPO } from './seed'

/**
 * What the Now tab says about the state of its own data: loading, all clear,
 * partly checked, or not checked at all. The promise behind every one of
 * these is that the page never says "All clear" unless every repository
 * answered.
 *
 * These run on the phone as well as the desktop, so nothing here may depend
 * on hovering or on a desktop-only layout.
 */

const SITE: RepoRef = { owner: 'acme', name: 'site' }

/** Four listings: both statuses, for both repositories. */
const ONE_POLL = 4

const EMPTY_LISTING = { total_count: 0, workflow_runs: [] }
const IDLE_TITLE = `0/${PLANS.pro.macos} macOS · 0 queued`

test.use({ seed: dashboardSeed({ repos: [REPO, SITE] }) })

test('two quiet repositories read as all clear once both have answered', async ({ page, github }) => {
  github.runs(REPO, [], []).runs(SITE, [], [])
  await page.goto('./')

  const clear = page.locator('.section', { has: page.locator('.section-title', { hasText: /^All clear$/ }) })
  await expect(clear).toBeVisible()
  await expect(clear.locator('.section-stats')).toHaveText('All 2 repositories checked')
  await expect(page).toHaveTitle(IDLE_TITLE)
  await expect(page.locator('.health')).toHaveCount(0)
  await expect(page.locator('.cant-check')).toHaveCount(0)
  // An all-clear speaks for both repositories, so both must have been asked both questions.
  expect(github.callsTo(LISTINGS).map((call) => call.path).sort()).toEqual(
    [REPO, SITE]
      .flatMap((repo) =>
        ['queued', 'in_progress'].map((status) => `/repos/${repo.owner}/${repo.name}/actions/runs${runsQuery(status)}`),
      )
      .sort(),
  )
})

test('a repository that cannot be checked holds back the all-clear until it answers', async ({ page, github }) => {
  github.runs(REPO, [], []).failRuns(SITE, json({ message: 'Server Error' }, { status: 500 }))
  await page.goto('./')

  const strip = page.locator('.banner.health[role="status"]')
  await expect(strip).toContainText("1 of 2 repositories couldn't be checked")
  await expect(strip.getByRole('listitem')).toHaveText(['site: GitHub had a server error · since 10:05'])
  const quiet = page.locator('.section', {
    has: page.locator('.section-title', { hasText: /^Nothing running or queued$/ }),
  })
  await expect(quiet.locator('.empty')).toHaveText(
    'Nothing is running or queued in the 1 repository that answered. The others could not be checked.',
  )
  await expect(page.getByText(/all clear/i)).toHaveCount(0)
  await expect(page.locator('.cant-check')).toHaveCount(0)

  github.runs(SITE, [], [])
  await page.clock.fastForward(15_000)

  await expect(page.locator('.section-title', { hasText: /^All clear$/ })).toBeVisible()
  await expect(strip).toHaveCount(0)
  await expect(quiet).toHaveCount(0)
})

test('when no repository answers the page says it cannot check, and Try again asks again', async ({
  page,
  github,
}) => {
  github.failRuns(REPO, networkError()).failRuns(SITE, networkError())
  await page.goto('./')

  const alert = page.locator('section.cant-check[role="alert"]')
  await expect(alert.locator('.section-title')).toHaveText("Can't check GitHub right now")
  await expect(alert).toContainText('This is not an all-clear.')
  await expect(alert).toContainText('None of the 2 repositories answered: no response from GitHub, since 10:05.')
  await expect(page).toHaveTitle("Can't check · actiondash")
  await expect(page.locator('button.pill')).toHaveText("Can't reach GitHub")
  await expect(page.getByText(/all clear/i)).toHaveCount(0)

  // Five seconds after a check, asking again is still refused. The footer's
  // age shows the page has caught up with the clock first, so the refusal is
  // not one left over from while the check was still in hand.
  const tryAgain = alert.getByRole('button', { name: 'Try again' })
  await page.clock.fastForward(5_000)
  await expect(page.locator('.footer')).toContainText(/Updated [5-9]s ago/)
  await expect(tryAgain).toHaveAttribute('title', 'Checked moments ago.')
  await expect(tryAgain).toHaveAttribute('aria-disabled', 'true')
  await github.expectNoNewCalls(() => tryAgain.click({ force: true }))

  await page.clock.fastForward(5_000)
  await expect(tryAgain).toHaveAttribute('aria-disabled', 'false')
  const before = github.callsTo(LISTINGS).length
  await tryAgain.click()
  await github.waitForCalls(LISTINGS, before + ONE_POLL)
})

test('a spent allowance pauses checking until it refills, then checking resumes', async ({ page, github }) => {
  const refillsAt = Math.floor(FIXED_NOW.getTime() / 1000) + 30 * 60
  const refused = json(
    { message: 'API rate limit exceeded for user ID 1.' },
    { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(refillsAt) } },
  )
  github.failRuns(REPO, refused).failRuns(SITE, refused)
  await page.goto('./')

  const pill = page.locator('button.pill')
  await expect(page).toHaveTitle('Paused · actiondash')
  await expect(pill).toHaveText('Paused until 10:35')
  await expect(pill).toHaveAttribute('aria-disabled', 'true')
  const alert = page.locator('section.cant-check[role="alert"]')
  await expect(alert).toContainText('This is not an all-clear.')
  await expect(alert).toContainText('The hourly request allowance is used up until 10:35.')
  await expect(page.getByText(/all clear/i)).toHaveCount(0)

  // Neither the interval nor the reader may spend what is not there.
  await github.expectNoNewCalls(async () => {
    await pill.click({ force: true })
    await page.clock.fastForward(60_000)
  })
  // Still quiet a minute before the refill, so the pause lasts until then and not merely a while.
  await github.expectNoNewCalls(() => page.clock.fastForward(28 * 60_000))
  await expect(pill).toHaveText('Paused until 10:35')

  const before = github.callsTo(LISTINGS).length
  github.runs(REPO, [], []).runs(SITE, [], [])
  await page.clock.fastForward(2 * 60_000)

  await github.waitForCalls(LISTINGS, before + ONE_POLL)
  await expect(page.locator('.section-title', { hasText: /^All clear$/ })).toBeVisible()
  await expect(page).toHaveTitle(IDLE_TITLE)
  await expect(alert).toHaveCount(0)
})

test('a refusal that gives no time still pauses checking, for the minute GitHub asks', async ({ page, github }) => {
  // A secondary limit can refuse without any x-ratelimit header, and before
  // any reply has carried one there is no reset to fall back on either.
  github.defaultRateHeaders = false
  const refused = json({ message: 'You have exceeded a secondary rate limit.' }, { status: 403 })
  github.failRuns(REPO, refused).failRuns(SITE, refused)
  await page.goto('./')

  const pill = page.locator('button.pill')
  await expect(page).toHaveTitle('Paused · actiondash')
  await expect(pill).toHaveText('Paused until 10:06')
  const alert = page.locator('section.cant-check[role="alert"]')
  await expect(alert).toContainText('This is not an all-clear.')
  await expect(page.getByText(/all clear/i)).toHaveCount(0)

  await github.expectNoNewCalls(() => page.clock.fastForward(50_000))

  const before = github.callsTo(LISTINGS).length
  github.defaultRateHeaders = true
  github.runs(REPO, [], []).runs(SITE, [], [])
  await page.clock.fastForward(15_000)

  await github.waitForCalls(LISTINGS, before + ONE_POLL)
  await expect(page.locator('.section-title', { hasText: /^All clear$/ })).toBeVisible()
  await expect(alert).toHaveCount(0)
})

test('offline, the page says so and asks nothing until the network is back', async ({ page, github, context }) => {
  github.runs(REPO, [], []).runs(SITE, [], [])
  await page.goto('./')
  await expect(page.locator('.section-title', { hasText: /^All clear$/ })).toBeVisible()

  await context.setOffline(true)
  await expect(page.locator('button.pill')).toHaveText('Offline')
  await expect(page).toHaveTitle('Offline · actiondash')
  const alert = page.locator('section.cant-check[role="alert"]')
  await expect(alert).toContainText('This is not an all-clear.')
  await expect(alert).toContainText('This device is offline. Checking starts again as soon as it is back online.')
  await expect(page.getByText(/all clear/i)).toHaveCount(0)
  // Two scheduled checks come and go without a request. Routed requests
  // bypass the offline emulation, so one made would be recorded here.
  await github.expectNoNewCalls(() => page.clock.fastForward(30_000))

  // With the clock stopped no timer can fire, so a request now can only come
  // from the page noticing the network is back.
  const pageNow = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(pageNow + 1_000)
  const before = github.callsTo(LISTINGS).length
  await context.setOffline(false)

  await github.waitForCalls(LISTINGS, before + ONE_POLL)
  await expect(page.locator('.section-title', { hasText: /^All clear$/ })).toBeVisible()
  await expect(page).toHaveTitle(IDLE_TITLE)
  await expect(alert).toHaveCount(0)
})

test('the first check shows its progress repository by repository, then the runs', async ({ page, github }) => {
  const run = makeRun({ id: 1, run_number: 1, status: 'in_progress', repoName: 'site' })
  github.runs(REPO, [], []).runs(SITE, [], [run])
  github.jobs(1, [makeJob({ id: 11, run_id: 1, status: 'in_progress', started_at: '2026-09-09T10:01:00Z' })])
  const app = deferred()
  const site = deferred()
  github.listing(REPO, 'queued', app.reply)
  github.listing(SITE, 'queued', site.reply)
  await page.goto('./')

  const loading = page.locator('.section', { has: page.locator('.section-title', { hasText: /^Loading$/ }) })
  await expect(loading.locator('.section-stats')).toHaveText('0 of 2 repositories')
  await expect(page.getByText(/all clear/i)).toHaveCount(0)
  // The tab makes no claim about the pool until every repository has answered.
  await expect(page).toHaveTitle('actiondash')

  app.resolve(json(EMPTY_LISTING))
  await expect(loading.locator('.section-stats')).toHaveText('1 of 2 repositories')
  await expect(page).toHaveTitle('actiondash')

  site.resolve(json(EMPTY_LISTING))
  await expect(page.locator('[data-run="1"]')).toBeVisible()
  await expect(page.locator('.topbar-meta').getByText('1 running', { exact: true })).toBeVisible()
  await expect(loading).toHaveCount(0)
  await expect(page).toHaveTitle(`1/${PLANS.pro.macos} macOS · 0 queued`)
})
