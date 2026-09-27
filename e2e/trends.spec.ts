import type { Page } from '@playwright/test'
import type { HistoryState } from '../src/model/history'
import { deferred, json } from '../tests/replies'
import { expect, test } from './fixtures'
import { dashboardSeed, FIXED_NOW, REPO } from './seed'

/**
 * The Trends screen draws what this browser recorded, and what GitHub says
 * about the hourly allowance, and says so plainly when it has nothing yet.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = FIXED_NOW.getTime()

const QUEUED = /\/repos\/acme\/app\/actions\/runs\?.*status=queued/
const RUNNING = /\/repos\/acme\/app\/actions\/runs\?.*status=in_progress/

function occupancy(page: Page) {
  return page.locator('svg.occ')
}

function budget(page: Page) {
  return page.locator('section', { has: page.locator('.section-title', { hasText: 'API budget this hour' }) })
}

async function openTrends(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Trends' }).click()
  await expect(page.getByRole('group', { name: 'Range' })).toBeVisible()
}

test.describe('with a recorded history', () => {
  // Three busy spells, each busier the further back it is, so every range
  // has a different peak. Nothing is queued and each spell is past the Pro
  // plan's macOS ceiling of five, as on an account whose real plan is bigger
  // than the one picked. That way the peak is the number of jobs in use
  // whether or not the summary counts the queue or the ceiling towards it.
  const history: HistoryState = {
    samples: [
      { t: NOW - 20 * HOUR, until: NOW - 19 * HOUR, inUse: { macos: 9 }, queued: {}, gap: true },
      { t: NOW - 3 * HOUR, until: NOW - 2 * HOUR, inUse: { macos: 7 }, queued: {}, gap: true },
      { t: NOW - 40 * MINUTE, until: NOW - 20 * MINUTE, inUse: { macos: 6 }, queued: {} },
    ],
    days: {},
  }
  test.use({ seed: { ...dashboardSeed(), history } })

  test('the occupancy chart draws the chosen range, and its summary follows the range', async ({ page, github }) => {
    github.runs(REPO, [], [])
    await page.goto('./')
    await expect(page.locator('.section-title', { hasText: 'All clear' })).toBeVisible()
    await openTrends(page)

    const range = page.getByRole('group', { name: 'Range' })
    const chart = occupancy(page)
    await expect(page.locator('.section-title', { hasText: 'macOS slots in use' })).toBeVisible()
    await expect(range.getByRole('button', { name: '6h' })).toHaveAttribute('aria-pressed', 'true')
    await expect(chart).toHaveAttribute('aria-label', 'Slots in use over time. Up to 7 at once against a ceiling of 5.')
    await expect(chart.locator('.occ-inuse').first()).toBeVisible()
    await expect(chart.getByText('nothing recorded in this window')).toHaveCount(0)

    const expected = {
      '1h': 'Up to 6 at once against a ceiling of 5.',
      '24h': 'Up to 9 at once against a ceiling of 5.',
      '6h': 'Up to 7 at once against a ceiling of 5.',
    }
    for (const [label, summary] of Object.entries(expected)) {
      await range.getByRole('button', { name: label }).click()
      await expect(range.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true')
      await expect(range.locator('[aria-pressed="true"]')).toHaveCount(1)
      await expect(chart).toHaveAttribute('aria-label', `Slots in use over time. ${summary}`)
    }
  })
})

test.describe('with nothing recorded', () => {
  test.use({ seed: dashboardSeed() })

  test('before the first poll, every card says what it is waiting for instead of drawing nothing', async ({
    page,
    github,
  }) => {
    // The first poll is held open, so nothing has been recorded or measured.
    const queued = deferred()
    const running = deferred()
    github.on(QUEUED, queued.reply)
    github.on(RUNNING, running.reply)
    await page.goto('./#trends')
    await github.waitForCalls(RUNNING)

    const chart = occupancy(page)
    await expect(chart).toHaveAttribute('aria-label', 'Slots in use over time. No data in this window.')
    await expect(chart.getByText('nothing recorded in this window')).toBeVisible()
    await expect(chart.locator('.occ-inuse')).toHaveCount(0)
    await expect(page.getByText('The chart fills in while the dashboard is open')).toBeVisible()
    await expect(page.getByText('Nothing recorded yet today. Slot time accrues while the dashboard is open.')).toBeVisible()
    await expect(page.getByText('Nothing learned yet. Durations are learned as jobs finish.')).toBeVisible()
    await expect(page.getByText('Known after the first poll.')).toBeVisible()

    // Once GitHub answers, the budget is known.
    const empty = json({ total_count: 0, workflow_runs: [] })
    queued.resolve(empty)
    running.resolve(empty)
    await expect(page.getByText('Known after the first poll.')).toBeHidden()
    await expect(budget(page).locator('.section-stats')).toContainText('of 5,000 left')
  })
})

test.describe('with a slow refresh', () => {
  test.use({ seed: dashboardSeed({ pollIntervalMs: 60_000 }) })

  test('the API budget shows the allowance GitHub reported, and follows it from poll to poll', async ({
    page,
    github,
  }) => {
    // Half an hour to the reset, as GitHub states it in every reply.
    const reset = String(NOW / 1000 + 30 * 60)
    const listing = (remaining: number) =>
      json(
        { total_count: 0, workflow_runs: [] },
        {
          headers: {
            'x-ratelimit-limit': '5000',
            'x-ratelimit-remaining': String(remaining),
            'x-ratelimit-used': String(5000 - remaining),
            'x-ratelimit-resource': 'core',
            'x-ratelimit-reset': reset,
          },
        },
      )
    github.on(QUEUED, listing(3210))
    github.on(RUNNING, listing(3210))

    await page.goto('./#trends')
    const bar = budget(page)
    await expect(bar.locator('.section-stats')).toHaveText('3,210 of 5,000 left')
    // Two requests a minute is 120 an hour, so 60 go in the half hour left.
    await expect(bar.getByRole('img')).toHaveAttribute(
      'aria-label',
      '3210 of 5000 requests left. About 3150 at the reset at 10:35:00 at the current cadence.',
    )
    await expect(bar).toContainText('~3,150 at reset 10:35')
    await expect(bar).toContainText('Refreshing every 60s costs 2 requests.')

    github.on(QUEUED, listing(3100))
    github.on(RUNNING, listing(3100))
    await page.clock.fastForward(60_000)
    await expect(bar.locator('.section-stats')).toHaveText('3,100 of 5,000 left')
  })
})
