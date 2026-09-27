import type { Page } from '@playwright/test'
import type { WorkflowJob } from '../src/github/types'
import type { DurationMap } from '../src/model/durations'
import { makeJob, makeRun } from '../tests/helpers'
import { deferred, empty, json } from '../tests/replies'
import { expect, test } from './fixtures'
import { LISTINGS } from './scenarios'
import type { BrowserGitHub } from './github'
import { dashboardSeed, FIXED_NOW, REPO } from './seed'

/**
 * The writes the reader can make from the dashboard: cancelling a run,
 * cancelling every superseded run at once, and re-running a failed one. Each
 * asks first, sends exactly the request GitHub documents, and then looks again.
 */

test.use({ seed: dashboardSeed() })

const CANCEL_1 = /\/repos\/acme\/app\/actions\/runs\/1\/cancel$/
const FORCE_CANCEL_1 = /\/repos\/acme\/app\/actions\/runs\/1\/force-cancel$/
const ANY_CANCEL = /\/actions\/runs\/\d+\/(force-)?cancel$/

/** One run of acme/app, number 12, holding a macOS slot with a single job. */
function scriptOneRunningRun(github: BrowserGitHub): void {
  github.runs(REPO, [], [makeRun({ id: 1, run_number: 12, status: 'in_progress' })])
  github.jobs(1, [makeJob({ id: 11, run_id: 1, status: 'in_progress', started_at: '2026-09-09T10:01:00Z' })])
}

/** Stops the page's clock just ahead of where it is, so timers fire only when the test says. */
async function pauseClock(page: Page): Promise<void> {
  const at = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(new Date(at + 1_000))
}

test.describe('cancelling one run', () => {
  test('cancel asks first, Escape backs out without a request, and confirming sends one cancel then looks again', async ({
    page,
    github,
  }) => {
    scriptOneRunningRun(github)
    const reply = deferred()
    github.write(CANCEL_1, reply.reply)

    await page.goto('./')
    const row = page.locator('[data-run="1"]')
    const cancel = row.getByRole('button', { name: 'Cancel app run #12' })
    await expect(cancel).toBeVisible()
    const confirm = row.getByRole('group', { name: 'Confirm cancel' })

    // The first click only asks, and Escape takes the question back. Neither
    // may reach GitHub.
    await github.expectNoNewCalls(async () => {
      await cancel.click()
      await expect(cancel).toHaveAttribute('aria-expanded', 'true')
      await expect(confirm).toContainText('Cancel run #12?')
      await expect(confirm.getByRole('button', { name: 'Keep' })).toBeFocused()

      await page.keyboard.press('Escape')
      await expect(confirm).toBeHidden()
      await expect(cancel).toHaveAttribute('aria-expanded', 'false')
      await expect(cancel).toBeFocused()
    })

    await cancel.click()
    const listingsBefore = github.callsTo(LISTINGS).length
    await confirm.getByRole('button', { name: 'Yes, cancel' }).click()

    // While GitHub has not answered, the row says so instead of offering the
    // button again. The button that had focus is gone, so what took its place
    // holds focus, rather than leaving the reader at the top of the page.
    await github.waitForCalls(CANCEL_1, 1, 'POST')
    const status = row.getByRole('status')
    await expect(row.getByText('cancelling…')).toBeFocused()
    await expect(status).toHaveText('cancelling…')
    await expect(cancel).toBeHidden()

    reply.resolve(empty(202))
    await expect(status).toHaveText('cancel requested')
    await expect(status).toBeFocused()
    // A successful cancel asks for a poll at once, so its effect shows.
    await github.waitForCalls(LISTINGS, listingsBefore + 1)

    expect(github.callsTo(ANY_CANCEL).map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /repos/acme/app/actions/runs/1/cancel',
    ])
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('a run that is already tearing down is force-cancelled instead, without an error', async ({ page, github }) => {
    scriptOneRunningRun(github)
    github.write(CANCEL_1, json({ message: 'Cannot cancel a workflow run that is completed.' }, { status: 409 }))
    github.write(FORCE_CANCEL_1)

    await page.goto('./')
    const row = page.locator('[data-run="1"]')
    await row.getByRole('button', { name: 'Cancel app run #12' }).click()
    const listingsBefore = github.callsTo(LISTINGS).length
    await row.getByRole('group', { name: 'Confirm cancel' }).getByRole('button', { name: 'Yes, cancel' }).click()

    await github.waitForCalls(FORCE_CANCEL_1, 1, 'POST')
    await expect(row.getByText('cancel requested')).toBeVisible()
    await github.waitForCalls(LISTINGS, listingsBefore + 1)

    expect(github.callsTo(ANY_CANCEL).map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /repos/acme/app/actions/runs/1/cancel',
      'POST /repos/acme/app/actions/runs/1/force-cancel',
    ])
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('a refused cancel says why in an alert and offers the button again', async ({ page, github }) => {
    scriptOneRunningRun(github)
    github.write(CANCEL_1, json({ message: 'Resource not accessible by personal access token' }, { status: 403 }))

    await page.goto('./')
    const row = page.locator('[data-run="1"]')
    const cancel = row.getByRole('button', { name: 'Cancel app run #12' })
    await cancel.click()
    await row.getByRole('group', { name: 'Confirm cancel' }).getByRole('button', { name: 'Yes, cancel' }).click()

    const alert = page.getByRole('alert')
    await expect(alert).toContainText(
      'Could not cancel app #12 (Resource not accessible by personal access token).',
    )
    await expect(cancel).toBeVisible()
    await expect(cancel).toBeFocused()
    await expect(row.getByText('cancel requested')).toBeHidden()
    // Only a 409 means "try force-cancel"; a refusal is final.
    expect(github.callsTo(FORCE_CANCEL_1)).toEqual([])

    await alert.getByRole('button', { name: 'dismiss' }).click()
    await expect(alert).toBeHidden()
  })
})

/** Every build of acme/app takes ten minutes, so the insight has figures to work from. */
const TEN_MINUTE_BUILDS: DurationMap = {
  'acme/app::build': { secs: [600], ids: [901], cls: 'macos', seenAt: FIXED_NOW.getTime() - 3_600_000 },
}

const RUN_1 = makeRun({ id: 1, run_number: 1, status: 'in_progress', head_sha: 'b'.repeat(40) })
const RUN_2 = makeRun({ id: 2, run_number: 2, status: 'in_progress', head_sha: 'c'.repeat(40) })
const RUN_3 = makeRun({ id: 3, run_number: 3, status: 'queued', head_sha: 'd'.repeat(40) })

function runningJobs(runId: number, ids: number[], started: string) {
  return ids.map((id) => makeJob({ id, run_id: runId, status: 'in_progress', started_at: started }))
}

/**
 * Pro's five macOS slots, all held by runs 1 and 2, which run 3 on a newer
 * commit of the same branch has superseded. Run 3 waits for a slot. Cancelling
 * either would start it at once; the insight names the first, run 1.
 */
function scriptFullPool(github: BrowserGitHub): void {
  github.runs(REPO, [RUN_3], [RUN_1, RUN_2])
  github.jobs(1, runningJobs(1, [11, 12, 13], '2026-09-09T10:01:00Z'))
  github.jobs(2, runningJobs(2, [21, 22], '2026-09-09T10:02:00Z'))
  github.jobs(3, [makeJob({ id: 31, run_id: 3, created_at: '2026-09-09T10:03:00Z' })])
}

test.describe('cancelling from the insight', () => {
  test.use({ seed: { ...dashboardSeed(), durations: TEN_MINUTE_BUILDS } })

  test('a cancel already asked for is offered again neither in the insight nor in the tiles', async ({
    page,
    github,
  }) => {
    scriptFullPool(github)
    const reply = deferred()
    github.write(CANCEL_1, reply.reply)

    await page.goto('./')
    const insight = page.locator('.insight')
    const tiles = page.locator('.tiles')
    await expect(insight).toContainText('The next free slot goes to app #1, which is superseded by #3.')
    await expect(tiles).toContainText('if you cancel #1')

    await insight.getByRole('button', { name: 'Cancel #1', exact: true }).click()
    const listingsBefore = github.callsTo(LISTINGS).length
    await insight.getByRole('group', { name: 'Confirm cancel' }).getByRole('button', { name: 'Yes, cancel #1' }).click()
    await github.waitForCalls(CANCEL_1, 1, 'POST')
    const status = insight.getByRole('status')
    await expect(status).toHaveText('cancelling…')
    await expect(status).toBeFocused()
    reply.resolve(empty(202))

    // Run 1 holds its slots until GitHub catches up, but it has been asked, so
    // the insight moves on to run 2, and stays there after the check the
    // cancel asks for.
    await github.waitForCalls(LISTINGS, listingsBefore + 2)
    await expect(insight).toContainText('The next free slot goes to app #2, which is superseded by #3.')
    await expect(insight.getByRole('button', { name: 'Cancel #2', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Cancel #1', exact: true })).toHaveCount(0)
    await expect(tiles).toContainText('if you cancel #2')
    await expect(tiles).not.toContainText('cancel #1')
  })

  test('a question left open when a check changes the insight is taken back, never turned on another run', async ({
    page,
    github,
  }) => {
    scriptFullPool(github)

    await page.goto('./')
    const insight = page.locator('.insight')
    await insight.getByRole('button', { name: 'Cancel #1', exact: true }).click()
    const confirm = insight.getByRole('group', { name: 'Confirm cancel' })
    await expect(confirm.getByRole('button', { name: 'Yes, cancel #1' })).toBeVisible()

    // Before the next check, run 1 ends and a run on another branch takes its
    // slots, so the insight names run 2 instead.
    const other = makeRun({ id: 4, run_number: 4, status: 'in_progress', head_branch: 'main', head_sha: 'e'.repeat(40) })
    github.runs(REPO, [RUN_3], [RUN_2, other])
    github.jobs(
      1,
      [11, 12, 13].map((id) =>
        makeJob({
          id,
          run_id: 1,
          status: 'completed',
          conclusion: 'cancelled',
          started_at: '2026-09-09T10:01:00Z',
          completed_at: '2026-09-09T10:05:05Z',
        }),
      ),
    )
    github.jobs(4, runningJobs(4, [41, 42, 43], '2026-09-09T10:05:05Z'))
    await page.clock.fastForward(15_000)

    await expect(insight).toContainText('The next free slot goes to app #2, which is superseded by #3.')
    await expect(confirm).toBeHidden()
    await expect(insight.getByRole('button', { name: 'Cancel #2', exact: true })).toBeVisible()
    expect(github.callsTo(ANY_CANCEL)).toEqual([])
  })
})

test('a run with jobs in two pools asks to cancel all its unfinished jobs, from either row', async ({
  page,
  github,
}) => {
  // Run 12 builds on two macOS slots and waits for a Linux one: one row in
  // each pool, and one cancel that stops all three jobs.
  github.runs(REPO, [], [makeRun({ id: 1, run_number: 12, status: 'in_progress' })])
  github.jobs(1, [
    makeJob({ id: 11, run_id: 1, name: 'build', status: 'in_progress', started_at: '2026-09-09T10:01:00Z' }),
    makeJob({ id: 12, run_id: 1, name: 'build-arm', status: 'in_progress', started_at: '2026-09-09T10:01:00Z' }),
    makeJob({ id: 13, run_id: 1, name: 'lint', labels: ['ubuntu-latest'] }),
  ])

  await page.goto('./')
  const pool = (name: string) =>
    page.locator('.section', { has: page.locator('.section-title', { hasText: new RegExp(`^${name}$`) }) })
  const macosRow = pool('macOS').locator('[data-run="1"]')
  const linuxRow = pool('Linux').locator('[data-run="1"]')
  const macosCancel = macosRow.getByRole('button', { name: /^Cancel app run #12/ })
  await expect(macosCancel).toHaveAccessibleName('Cancel app run #12 (3 unfinished jobs)')
  await expect(linuxRow.getByRole('button', { name: /^Cancel app run #12/ })).toHaveAccessibleName(
    'Cancel app run #12 (3 unfinished jobs)',
  )

  await github.expectNoNewCalls(async () => {
    await macosCancel.click()
    await expect(macosRow.getByRole('group', { name: 'Confirm cancel' })).toContainText(
      'Cancel run #12 and its 3 unfinished jobs?',
    )
    await page.keyboard.press('Escape')
    await expect(macosCancel).toBeFocused()
  })
})

test('cancelling every superseded run sends one cancel, then the next only after a full second', async ({
  page,
  github,
}) => {
  // Three runs of one workflow on one branch, each on a newer commit: the
  // newest supersedes the other two.
  const run = (id: number, sha: string, started: string) => {
    github.jobs(id, [makeJob({ id: id * 10, run_id: id, status: 'in_progress', started_at: started })])
    return makeRun({ id, run_number: id, status: 'in_progress', head_sha: sha.repeat(40) })
  }
  github.runs(REPO, [], [
    run(1, 'b', '2026-09-09T10:01:00Z'),
    run(2, 'c', '2026-09-09T10:02:00Z'),
    run(3, 'd', '2026-09-09T10:03:00Z'),
  ])
  github.write(/\/repos\/acme\/app\/actions\/runs\/[12]\/cancel$/)

  await page.goto('./')
  const bulk = page.getByRole('button', { name: 'Cancel 2 superseded' })
  await bulk.click()
  const confirm = page.locator('.bulk-confirm')
  await expect(confirm).toHaveAttribute('aria-label', 'Confirm cancel')
  await expect(confirm).toContainText('Cancel 2 superseded runs?')
  await expect(confirm.getByRole('button', { name: 'Keep' })).toBeFocused()

  // From here the clock moves only when the test moves it, so the spacing
  // between the two cancels can be measured exactly.
  await pauseClock(page)
  await confirm.getByRole('button', { name: 'Yes, cancel 2' }).click()

  await github.waitForCalls(ANY_CANCEL, 1, 'POST')
  // Shown once the first cancel is answered, in the same step that starts
  // the wait before the second.
  const progress = page.locator('.bulk-progress')
  await expect(progress).toHaveText('Cancelling 1 of 2…')
  await expect(progress).toBeFocused()
  expect(github.callsTo(ANY_CANCEL).map((c) => c.path)).toEqual(['/repos/acme/app/actions/runs/1/cancel'])

  await github.expectNoNewCalls(() => page.clock.runFor(999))

  await page.clock.runFor(1)
  await github.waitForCalls(ANY_CANCEL, 2, 'POST')
  expect(github.callsTo(ANY_CANCEL).map((c) => c.path)).toEqual([
    '/repos/acme/app/actions/runs/1/cancel',
    '/repos/acme/app/actions/runs/2/cancel',
  ])

  await expect(page.locator('[data-run="1"]').getByText('cancel requested')).toBeVisible()
  await expect(page.locator('[data-run="2"]').getByText('cancel requested')).toBeVisible()
  await expect(page.locator('[data-run="3"]').getByRole('button', { name: 'Cancel app run #3' })).toBeVisible()
  // Nothing superseded is left to cancel, so the offer goes, and what took its
  // place says what became of them and keeps focus.
  await expect(bulk).toBeHidden()
  await expect(progress).toHaveText('Cancel requested for 2 superseded runs.')
  await expect(progress).toBeFocused()
})

test('the question for a single superseded run speaks of it in the singular', async ({ page, github }) => {
  // Run 2, on a newer commit, supersedes run 1, which holds a slot and has
  // a second job waiting for one.
  github.runs(REPO, [], [
    makeRun({ id: 1, run_number: 1, status: 'in_progress', head_sha: 'b'.repeat(40) }),
    makeRun({ id: 2, run_number: 2, status: 'in_progress', head_sha: 'c'.repeat(40) }),
  ])
  github.jobs(1, [
    makeJob({ id: 11, run_id: 1, status: 'in_progress', started_at: '2026-09-09T10:01:00Z' }),
    makeJob({ id: 12, run_id: 1, name: 'test' }),
  ])
  github.jobs(2, [makeJob({ id: 21, run_id: 2, status: 'in_progress', started_at: '2026-09-09T10:02:00Z' })])

  await page.goto('./')
  await page.getByRole('button', { name: 'Cancel 1 superseded' }).click()

  const confirm = page.locator('.bulk-confirm')
  await expect(confirm).toContainText('Cancel 1 superseded run? It holds 1 macOS slot and has 1 job waiting.')
  await expect(confirm.getByRole('button', { name: 'Yes, cancel 1' })).toBeVisible()
})

test('re-running a failed run asks first, sends one re-run of the failed jobs, and says it was requested', async ({
  page,
  github,
}) => {
  const run = makeRun({ id: 1, run_number: 12, status: 'in_progress', name: 'CI' })
  github.runs(REPO, [], [run])
  github.jobs(1, [makeJob({ id: 11, run_id: 1, name: 'test', status: 'in_progress', started_at: '2026-09-09T10:01:00Z' })])

  await page.goto('./')
  await expect(page.locator('[data-run="1"]')).toBeVisible()

  // The run leaves the listings before the next poll, and its final job
  // listing says how it ended.
  github.runs(REPO, [], [])
  github.jobs(1, [
    makeJob({
      id: 11,
      run_id: 1,
      name: 'test',
      status: 'completed',
      conclusion: 'failure',
      started_at: '2026-09-09T10:01:00Z',
      completed_at: '2026-09-09T10:05:05Z',
    }),
  ])
  github.write(/\/repos\/acme\/app\/actions\/runs\/1\/rerun-failed-jobs$/)
  await page.clock.fastForward(15_000)

  const finished = page.locator('.finished-row', { hasText: '#12' })
  await expect(finished).toContainText('test failed')
  const rerun = finished.getByRole('button', { name: 'Re-run failed' })

  await github.expectNoNewCalls(async () => {
    await rerun.click()
    await expect(rerun).toHaveAttribute('aria-expanded', 'true')
  })
  const confirm = finished.getByRole('group', { name: 'Confirm re-run' })
  await expect(confirm).toContainText('Re-run the failed job of app #12? It joins the queue again.')
  await expect(confirm.getByRole('button', { name: 'Keep' })).toBeFocused()

  const listingsBefore = github.callsTo(LISTINGS).length
  await confirm.getByRole('button', { name: 'Yes, re-run' }).click()

  // The button that had focus is gone, so the note in its place takes focus.
  const note = finished.getByText('Re-run requested. It joins the queue on the next check.')
  await expect(note).toBeFocused()
  await expect(note).toHaveRole('status')
  await expect(rerun).toBeHidden()
  await github.waitForCalls(LISTINGS, listingsBefore + 1)
  expect(github.callsTo(/\/rerun/).map((c) => `${c.method} ${c.path}`)).toEqual([
    'POST /repos/acme/app/actions/runs/1/rerun-failed-jobs',
  ])
})

test('re-running two failed jobs says they both join the queue again', async ({ page, github }) => {
  const job = (id: number, name: string, over: Partial<WorkflowJob> = {}) =>
    makeJob({ id, run_id: 1, name, status: 'in_progress', started_at: '2026-09-09T10:01:00Z', ...over })
  github.runs(REPO, [], [makeRun({ id: 1, run_number: 12, status: 'in_progress' })])
  github.jobs(1, [job(11, 'test'), job(12, 'lint')])

  await page.goto('./')
  await expect(page.locator('[data-run="1"]')).toBeVisible()

  github.runs(REPO, [], [])
  const failed = { status: 'completed', conclusion: 'failure', completed_at: '2026-09-09T10:05:05Z' }
  github.jobs(1, [job(11, 'test', failed), job(12, 'lint', failed)])
  await page.clock.fastForward(15_000)

  const finished = page.locator('.finished-row', { hasText: '#12' })
  await expect(finished).toContainText('test failed · lint failed')
  await github.expectNoNewCalls(async () => {
    await finished.getByRole('button', { name: 'Re-run failed' }).click()
    await expect(finished.getByRole('group', { name: 'Confirm re-run' })).toContainText(
      'Re-run the 2 failed jobs of app #12? They join the queue again.',
    )
  })
})
