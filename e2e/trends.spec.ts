import type { Page } from '@playwright/test'
import type { HistoryState } from '../src/model/history'
import { makeJob, makeRun } from '../tests/helpers'
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
    await expect(chart).toHaveAttribute(
      'aria-label',
      'Slots in use and jobs queued over time. Up to 7 in use at once, against a ceiling of 5.',
    )
    await expect(chart.locator('.occ-inuse').first()).toBeVisible()
    await expect(chart.getByText('nothing recorded in this window')).toHaveCount(0)

    const expected = {
      '1h': 'Up to 6 in use at once, against a ceiling of 5.',
      '24h': 'Up to 9 in use at once, against a ceiling of 5.',
      '6h': 'Up to 7 in use at once, against a ceiling of 5.',
    }
    for (const [label, summary] of Object.entries(expected)) {
      await range.getByRole('button', { name: label }).click()
      await expect(range.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true')
      await expect(range.locator('[aria-pressed="true"]')).toHaveCount(1)
      await expect(chart).toHaveAttribute('aria-label', `Slots in use and jobs queued over time. ${summary}`)
    }
  })
})

test.describe('with learned durations', () => {
  // A ten-minute job and a fifteen-second one, which no single scale in
  // minutes could draw side by side.
  const learned = (build: number[]) => ({
    'acme/app::build': { secs: build, ids: build.map((_, i) => i + 1), cls: 'macos', seenAt: NOW - MINUTE },
    'acme/app::lint': { secs: [15], ids: [100], cls: 'macos', seenAt: NOW - 2 * MINUTE },
  })

  function strips(page: Page) {
    return page.locator('section', { has: page.locator('.section-title', { hasText: 'How long jobs take' }) })
  }

  test.describe('and nothing running', () => {
    test.use({ seed: { ...dashboardSeed(), durations: learned([540, 600, 660]) } })

    test('each job is drawn against its own usual time, so the usual lines up down the list', async ({
      page,
      github,
    }) => {
      github.runs(REPO, [], [])
      await page.goto('./#trends')
      const section = strips(page)
      const build = section.getByRole('img', { name: /^build / })
      const lint = section.getByRole('img', { name: /^lint / })

      // Nothing is running, so nothing is said to be marked.
      await expect(section.locator('.section-stats')).toHaveText('up to 10 successful runs')
      await expect(build).toHaveAttribute('aria-label', 'build usually takes 10m, from 3 successful runs of 9m to 11m')
      await expect(lint).toHaveAttribute('aria-label', 'lint usually takes 15s, from 1 successful run')
      await expect(section.locator('.strip-usual')).toHaveText(['usually 10m', 'usually 15s'])

      // Ten minutes in one row and fifteen seconds in the other sit at the same place.
      const usualX = await lint.locator('circle').getAttribute('cx')
      await expect(build.locator('circle').nth(1)).toHaveAttribute('cx', usualX!)
      await expect(build.locator('circle').first()).not.toHaveAttribute('cx', usualX!)
    })
  })

  test.describe('and a run going long', () => {
    // One earlier run took 25 minutes, past twice the usual ten.
    test.use({ seed: { ...dashboardSeed(), durations: learned([540, 590, 600, 660, 1500]) } })

    test('a run past twice its usual is marked at the end of the scale, as is an earlier one', async ({
      page,
      github,
    }) => {
      github.runs(REPO, [], [makeRun({ id: 1, run_number: 12, status: 'in_progress' })])
      // Thirty minutes in.
      github.jobs(1, [
        makeJob({ id: 11, run_id: 1, name: 'build', status: 'in_progress', started_at: '2026-09-09T09:35:00Z' }),
      ])
      await page.goto('./#trends')
      const section = strips(page)
      const build = section.getByRole('img', { name: /^build / })

      await expect(section.locator('.section-stats')).toHaveText('up to 10 successful runs · current run marked')
      await expect(build).toHaveAttribute(
        'aria-label',
        'build usually takes 10m, from 5 successful runs of 9m to 25m; this run 30m, past usual',
      )
      // Thirty minutes is past the end of a scale that runs to twice ten.
      const axisEnd = await build.locator('.strip-axis').getAttribute('x2')
      await expect(build.locator('.strip-today.over')).toHaveAttribute('x1', axisEnd!)
      // The 25-minute run is not a dot on the scale but one pointer past its end.
      await expect(build.locator('circle')).toHaveCount(4)
      await expect(build.locator('path title')).toHaveText('25m, past 2× usual')
    })
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
    await expect(chart).toHaveAttribute('aria-label', 'Slots in use and jobs queued over time. No data in this window.')
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
    // A quiet first reading is a quiet window, not use up to the ceiling.
    await expect(chart).toHaveAttribute(
      'aria-label',
      'Slots in use and jobs queued over time. Nothing ran or waited in this window.',
    )
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
