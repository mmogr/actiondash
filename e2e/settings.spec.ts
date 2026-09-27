import type { Page } from '@playwright/test'
import type { DurationMap } from '../src/model/durations'
import type { HistoryState } from '../src/model/history'
import { expect, test } from './fixtures'
import { LISTINGS } from './scenarios'
import { dashboardSeed, FIXED_NOW, KEYS, REPO } from './seed'

/**
 * The Settings screen: what the reader changes there is kept, takes effect at
 * once, and Forget leaves nothing behind.
 */

const durations: DurationMap = {
  'acme/app::build': { secs: [300, 320], ids: [901, 902], cls: 'macos', seenAt: FIXED_NOW.getTime() - 3_600_000 },
}

const history: HistoryState = {
  samples: [
    {
      t: FIXED_NOW.getTime() - 30 * 60_000,
      until: FIXED_NOW.getTime() - 20 * 60_000,
      inUse: { macos: 2 },
      queued: {},
      gap: true,
    },
  ],
  days: {},
}

test.use({ seed: { ...dashboardSeed(), durations, history } })

function stored(page: Page, key: string): Promise<string | null> {
  return page.evaluate((k) => localStorage.getItem(k), key)
}

/** Opens the dashboard on an empty pool, waits for the first poll, then goes to Settings. */
async function openSettings(page: Page): Promise<void> {
  await page.goto('./')
  await expect(page.locator('.section-title', { hasText: 'All clear' })).toBeVisible()
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible()
}

test('changing the plan is kept and moves the ceiling in the tab title', async ({ page, github }) => {
  github.runs(REPO, [], [])
  await openSettings(page)
  await expect(page).toHaveTitle('0/5 macOS · 0 queued')

  await page.getByLabel('Plan').selectOption('enterprise')

  await expect(page).toHaveTitle('0/50 macOS · 0 queued')
  expect(JSON.parse((await stored(page, KEYS.settings))!)).toMatchObject({ plan: 'enterprise' })

  await page.reload()
  await expect(page.getByLabel('Plan')).toHaveValue('enterprise')
  await expect(page).toHaveTitle('0/50 macOS · 0 queued')
})

test('a longer refresh interval is kept and the next poll waits for all of it', async ({ page, github }) => {
  github.runs(REPO, [], [])
  await openSettings(page)
  await expect(page.getByLabel('Refresh')).toHaveValue('15000')

  // From here the clock moves only when the test moves it, so the new timer
  // can be measured from the moment it was set.
  const at = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(new Date(at + 1_000))
  const listings = github.callsTo(LISTINGS).length

  await page.getByLabel('Refresh').selectOption('30s')
  expect(JSON.parse((await stored(page, KEYS.settings))!)).toMatchObject({ pollIntervalMs: 30_000 })

  // The poll the old 15-second timer had booked must not happen either.
  await github.expectNoNewCalls(() => page.clock.runFor(29_999))

  await page.clock.runFor(1)
  await github.waitForCalls(LISTINGS, listings + 2)
})

test('forgetting removes the token and every stored figure, and nothing is asked of GitHub again', async ({
  page,
  github,
}) => {
  github.runs(REPO, [], [])
  await openSettings(page)
  for (const key of Object.values(KEYS)) expect(await stored(page, key), key).not.toBeNull()

  const forget = page.getByRole('button', { name: 'Forget token and data' })
  await forget.click()
  const confirm = page.getByRole('group', { name: 'Confirm forget' })
  await expect(confirm).toContainText(
    'Remove the token, 1 repository, the Pro plan, learned durations for 1 job and occupancy history from this browser?',
  )
  await expect(confirm.getByRole('button', { name: 'Keep' })).toBeFocused()

  await github.expectNoNewCalls(async () => {
    await confirm.getByRole('button', { name: 'Yes, forget' }).click()
    await expect(page.getByLabel('Personal access token')).toBeVisible()
    for (const key of Object.values(KEYS)) expect(await stored(page, key), key).toBeNull()
    // Long enough for several polls, had polling carried on.
    await page.clock.fastForward(60_000)
  })

  await github.expectNoNewCalls(async () => {
    await page.reload()
    await expect(page.getByLabel('Personal access token')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Connect' })).toBeDisabled()
  })
  for (const key of Object.values(KEYS)) expect(await stored(page, key), key).toBeNull()
})
