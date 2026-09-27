import { PLANS } from '../src/model/plans'
import { makeJob, makeRun } from '../tests/helpers'
import { conditional } from '../tests/replies'
import { expect, test } from './fixtures'
import { LISTINGS } from './scenarios'
import { dashboardSeed, REPO } from './seed'

/**
 * What changes from one check to the next, and what that costs. A check runs
 * every fifteen seconds; page.clock.fastForward(15_000) brings the next one.
 */

/** The job listing of run 1. */
const JOBS_OF_RUN_1 = /\/actions\/runs\/1\/jobs\?/

test.use({ seed: dashboardSeed() })

test('a queued job that starts moves to Running on the next check', async ({ page, github }) => {
  const run = makeRun({ id: 1, run_number: 1 })
  github.runs(REPO, [run], [])
  github.jobs(1, [makeJob({ id: 11, run_id: 1 })])
  await page.goto('./')

  const row = page.locator('[data-run="1"]')
  const counts = page.locator('.topbar-meta')
  await expect(row).toBeVisible()
  await expect(page.locator('.group-label')).toHaveText(['Queued'])
  await expect(counts.getByText('0 running', { exact: true })).toBeVisible()
  await expect(counts.getByText('1 queued', { exact: true })).toBeVisible()

  // GitHub moves the run's updated_at when one of its jobs starts.
  github.runs(REPO, [], [{ ...run, status: 'in_progress', updated_at: '2026-09-09T10:05:10Z' }])
  github.jobs(1, [makeJob({ id: 11, run_id: 1, status: 'in_progress', started_at: '2026-09-09T10:05:08Z' })])
  await page.clock.fastForward(15_000)

  await expect(counts.getByText('1 running', { exact: true })).toBeVisible()
  await expect(counts.getByText('0 queued', { exact: true })).toBeVisible()
  await expect(page.locator('.group-label')).toHaveText(['Running'])
  await expect(row).toBeVisible()
  await expect(page).toHaveTitle(`1/${PLANS.pro.macos} macOS · 0 queued`)
  // The first check's listing, and one more because the run moved.
  expect(github.callsTo(JOBS_OF_RUN_1)).toHaveLength(2)
})

test('an unchanged queue is asked again with its ETag and costs no job listing', async ({ page, github }) => {
  const run = makeRun({ id: 1, run_number: 1, status: 'in_progress' })
  github.runs(REPO, [], [run])
  github.listing(REPO, 'queued', conditional('"queued-v1"', { total_count: 0, workflow_runs: [] }))
  github.listing(REPO, 'in_progress', conditional('"running-v1"', { total_count: 1, workflow_runs: [run] }))
  github.jobs(1, [makeJob({ id: 11, run_id: 1, status: 'in_progress', started_at: '2026-09-09T10:01:00Z' })])
  await page.goto('./')

  const row = page.locator('[data-run="1"]')
  await expect(row).toBeVisible()
  const first = github.callsTo(LISTINGS)
  expect(first.map((call) => call.headers['if-none-match'])).toEqual([undefined, undefined])

  await page.clock.fastForward(15_000)
  await github.waitForCalls(LISTINGS, 4)
  // The check ends as soon as its listings come back, and a job listing
  // would be asked for straight after them.
  await github.expectNoNewCalls(async () => {})

  // Sent back only because the page could read the ETag across origins, and
  // answered 304, which GitHub does not charge for.
  const again = github.callsTo(LISTINGS).slice(2)
  const sent = again.map((call) => [new URL(call.url).searchParams.get('status'), call.headers['if-none-match']])
  expect(Object.fromEntries(sent)).toEqual({ queued: '"queued-v1"', in_progress: '"running-v1"' })
  // The run's updated_at has not moved and its jobs are fifteen seconds old.
  expect(github.callsTo(JOBS_OF_RUN_1)).toHaveLength(1)
  // The 304 is answered from what the page kept, so nothing on it changes.
  await expect(row).toBeVisible()
  await expect(page.locator('.topbar-meta').getByText('1 running', { exact: true })).toBeVisible()
  await expect(page.locator('section.finished')).toHaveCount(0)
})

test('a run that leaves between checks is looked up once more and listed as finished with how it ended', async ({
  page,
  github,
}) => {
  const run = makeRun({ id: 1, run_number: 1, status: 'in_progress' })
  const job = makeJob({ id: 11, run_id: 1, name: 'test-ui', status: 'in_progress', started_at: '2026-09-09T10:01:00Z' })
  github.runs(REPO, [], [run])
  github.jobs(1, [job])
  await page.goto('./')
  await expect(page.locator('[data-run="1"]')).toBeVisible()
  await expect(page.locator('section.finished')).toHaveCount(0)

  // Gone from both listings while its last snapshot still had a job running,
  // so how it ended has not been seen yet.
  github.runs(REPO, [], [])
  github.jobs(1, [{ ...job, status: 'completed', conclusion: 'failure', completed_at: '2026-09-09T10:05:10Z' }])
  await page.clock.fastForward(15_000)

  const finished = page.locator('section.finished')
  await expect(finished.locator('.finished-row')).toHaveCount(1)
  const row = finished.locator('.finished-row.failed')
  await expect(row.locator('.group-repo')).toHaveText('app #1')
  await expect(row.locator('.finished-outcome')).toHaveText('test-ui failed')
  await expect(row.getByRole('link', { name: 'test-ui' })).toHaveAttribute('href', job.html_url)
  await expect(page.locator('[data-run="1"]')).toHaveCount(0)
  await expect(page.locator('.topbar-meta').getByText('0 running', { exact: true })).toBeVisible()
  expect(github.callsTo(JOBS_OF_RUN_1)).toHaveLength(2)
})
