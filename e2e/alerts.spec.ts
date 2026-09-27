import type { BrowserContext, Page } from '@playwright/test'
import type { AlertPrefs } from '../src/model/alerts'
import type { WorkflowRun } from '../src/github/types'
import { makeJob, makeRun } from '../tests/helpers'
import { expect, test } from './fixtures'
import { LISTINGS } from './scenarios'
import type { BrowserGitHub } from './github'
import { dashboardSeed, KEYS, REPO } from './seed'

/**
 * Alerts, as the reader meets them: what each permission state offers, a
 * test notification, and an alert about their own run that arrives once.
 *
 * Nothing real is shown. Both ways the page can show a notification, the
 * service worker registration and the page-level constructor, are replaced
 * with recorders before the page loads, so every notification is counted
 * whichever way it went, and whether or not it was allowed.
 *
 * The permission is the test's to set as well. context.grantPermissions
 * reaches navigator.permissions, but Chromium's headless shell, the browser
 * CI runs, still reports Notification.permission as "denied" after it.
 */

type Permission = 'default' | 'granted' | 'denied'

interface Shown {
  title: string
  body: string
}

interface Notifications {
  shown: Shown[]
  /** How many times the page asked for permission. */
  asked: number
}

async function fakeNotifications(
  context: BrowserContext,
  permission: Permission,
  answer: Permission = permission,
): Promise<Notifications> {
  const record: Notifications = { shown: [], asked: 0 }
  await context.exposeBinding('__e2eNotified', (_source, notification: Shown) => {
    record.shown.push(notification)
  })
  await context.exposeBinding('__e2eAsked', () => {
    record.asked++
  })
  await context.addInitScript(
    ({ permission, answer }) => {
      const hooks = window as unknown as { __e2eNotified(n: Shown): void; __e2eAsked(): void }
      const report = (title: string, options: NotificationOptions | undefined) =>
        hooks.__e2eNotified({ title, body: options?.body ?? '' })
      let current: Permission = permission

      ServiceWorkerRegistration.prototype.showNotification = function (title: string, options?: NotificationOptions) {
        report(title, options)
        return Promise.resolve()
      }

      function Recorded(title: string, options?: NotificationOptions) {
        report(title, options)
      }
      Object.defineProperty(Recorded, 'permission', { get: () => current })
      Object.defineProperty(Recorded, 'requestPermission', {
        value: () => {
          hooks.__e2eAsked()
          current = answer
          return Promise.resolve(answer)
        },
      })
      Object.defineProperty(window, 'Notification', { value: Recorded, configurable: true, writable: true })
    },
    { permission, answer },
  )
  return record
}

const NO_ALERTS: AlertPrefs = { myStarted: false, myFinished: false, slotFreed: false, jobStarted: false, superseded: false }
const CHOICES = ['My run starts', 'My run finishes', 'A slot frees', 'A queued job starts', 'A run is superseded']

/** A run of acme/app pushed by the reader, octocat, on a branch of its own. */
function myRun(id: number, over: Partial<WorkflowRun> = {}) {
  return makeRun({ id, run_number: id, actor: { login: 'octocat' }, head_branch: `topic-${id}`, ...over })
}

/**
 * Scripts the run's single job as queued, and returns what moves it on: its
 * job holding a slot, and the run as the next listing reports it.
 */
function queuedUntilStarted(github: BrowserGitHub, id: number): () => ReturnType<typeof myRun> {
  const queued = myRun(id)
  github.jobs(id, [makeJob({ id: id * 10, run_id: id, name: 'build' })])
  return () => {
    github.jobs(id, [
      makeJob({ id: id * 10, run_id: id, name: 'build', status: 'in_progress', started_at: '2026-09-09T10:05:10Z' }),
    ])
    // A run whose updated_at has not moved keeps its cached jobs.
    return { ...queued, status: 'in_progress', updated_at: '2026-09-09T10:05:10Z' }
  }
}

async function openAlerts(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Alerts' }).click()
  await expect(page.getByRole('heading', { name: 'Everyone' })).toBeVisible()
}

async function storedAlerts(page: Page): Promise<AlertPrefs> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), KEYS.settings)
  return (JSON.parse(raw!) as { alerts: AlertPrefs }).alerts
}

test.describe('with notifications allowed', () => {
  test.use({ seed: dashboardSeed({ alerts: { ...NO_ALERTS, myStarted: true } }) })

  test('a test notification is shown once, saying what alerts look like', async ({ page, context, github }) => {
    const notifications = await fakeNotifications(context, 'granted')
    github.runs(REPO, [], [])
    await page.goto('./#alerts')

    await expect(page.getByText('Notifications are allowed.')).toBeVisible()
    for (const label of CHOICES) await expect(page.getByRole('checkbox', { name: label })).toBeEnabled()
    await expect(page.getByRole('checkbox', { name: 'My run starts' })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: 'My run finishes' })).not.toBeChecked()

    await page.getByRole('button', { name: 'Send a test notification' }).click()
    await expect.poll(() => notifications.shown.length).toBe(1)
    // Long enough for a second copy to arrive, had one been sent.
    await github.expectNoNewCalls(async () => {})
    expect(notifications.shown).toEqual([
      { title: 'actiondash', body: 'Notifications work. Alerts arrive like this while the page is open.' },
    ])
  })

  test('you hear once that your run started, and not again on the next poll', async ({
    page,
    context,
    github,
  }) => {
    const notifications = await fakeNotifications(context, 'granted')
    const startFive = queuedUntilStarted(github, 5)
    const startSix = queuedUntilStarted(github, 6)
    github.runs(REPO, [myRun(5), myRun(6)], [])

    await page.goto('./')
    await expect(page.locator('[data-run="5"]')).toBeVisible()
    await expect(page.locator('[data-run="6"]')).toBeVisible()

    // Poll two: run 5 takes a slot.
    const runningFive = startFive()
    github.runs(REPO, [myRun(6)], [runningFive])
    await page.clock.fastForward(15_000)
    await expect.poll(() => notifications.shown.length).toBe(1)

    // Poll three: run 5 is still running, and now run 6 starts too. Run 6's
    // alert shows this poll was compared; run 5 must not be announced again.
    const runningSix = startSix()
    github.runs(REPO, [], [runningFive, runningSix])
    await page.clock.fastForward(15_000)
    await expect.poll(() => notifications.shown.length).toBeGreaterThanOrEqual(2)

    expect(notifications.shown).toEqual([
      { title: 'app #5 started', body: 'build took a macOS slot.' },
      { title: 'app #6 started', body: 'build took a macOS slot.' },
    ])
  })
})

test.describe('with notifications blocked', () => {
  test.use({ seed: dashboardSeed({ alerts: { myStarted: true, myFinished: true, slotFreed: true, jobStarted: true, superseded: true } }) })

  test('no alert choice can be changed, and nothing is shown when your own run starts', async ({
    page,
    context,
    github,
  }) => {
    const notifications = await fakeNotifications(context, 'denied')
    const startFive = queuedUntilStarted(github, 5)
    github.runs(REPO, [myRun(5)], [])

    await page.goto('./')
    await expect(page.locator('[data-run="5"]')).toBeVisible()

    const listings = github.callsTo(LISTINGS).length
    github.runs(REPO, [], [startFive()])
    await page.clock.fastForward(15_000)
    await github.waitForCalls(LISTINGS, listings + 2)
    await expect(page).toHaveTitle('#5 running · actiondash')

    // Long enough for a notification to arrive, had one been sent.
    await github.expectNoNewCalls(() => openAlerts(page))
    await expect(page.getByText('Notifications are blocked for this site.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Allow notifications' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Send a test notification' })).toHaveCount(0)
    for (const label of CHOICES) await expect(page.getByRole('checkbox', { name: label })).toBeDisabled()
    expect(notifications.shown).toEqual([])
  })
})

test.describe('before notifications are asked for', () => {
  test.use({ seed: dashboardSeed() })

  test('allowing notifications turns on the two alerts about your own runs and nothing else', async ({
    page,
    context,
    github,
  }) => {
    const notifications = await fakeNotifications(context, 'default', 'granted')
    github.runs(REPO, [], [])
    await page.goto('./#alerts')

    for (const label of CHOICES) await expect(page.getByRole('checkbox', { name: label })).toBeDisabled()
    await expect(page.getByText('Allow notifications above to turn these on.')).toBeVisible()
    expect(notifications.asked).toBe(0)

    await page.getByRole('button', { name: 'Allow notifications' }).click()

    await expect(page.getByText('Notifications are allowed.')).toBeVisible()
    await expect(page.getByRole('checkbox', { name: 'My run starts' })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: 'My run finishes' })).toBeChecked()
    for (const label of CHOICES.slice(2)) {
      await expect(page.getByRole('checkbox', { name: label })).toBeEnabled()
      await expect(page.getByRole('checkbox', { name: label })).not.toBeChecked()
    }
    expect(notifications.asked).toBe(1)
    expect(await storedAlerts(page)).toEqual({ ...NO_ALERTS, myStarted: true, myFinished: true })
    expect(notifications.shown).toEqual([])
  })
})
