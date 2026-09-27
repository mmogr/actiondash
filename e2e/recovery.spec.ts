import type { Page } from '@playwright/test'
import { json } from '../tests/replies'
import { expect, test } from './fixtures'
import { bearer, credential, LISTINGS, ref, repo, REPOS_PATH, requests } from './scenarios'
import { dashboardSeed, FIXED_NOW, KEYS, NEW_TOKEN, REPO } from './seed'

/**
 * What happens when GitHub stops accepting the stored token: the dashboard
 * stops asking, says so, keeps saying so across a reload, and takes a new
 * token without making the reader set everything up again.
 */

const REJECTED = json({ message: 'Bad credentials' }, { status: 401 })
/** Five minutes before the page's clock starts, which the playwright config shows in UTC. */
const REJECTED_AT = FIXED_NOW.getTime() - 5 * 60_000
/** The poll interval a new browser starts with. */
const POLL_MS = 15_000

async function storedSettings(page: Page): Promise<Record<string, unknown>> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), KEYS.settings)
  expect(raw, 'stored settings').not.toBeNull()
  return JSON.parse(raw!) as Record<string, unknown>
}

/** HH:MM of a moment, in the UTC the playwright config runs the page in. */
function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16)
}

function recoveryCard(page: Page) {
  return page.getByRole('heading', { name: 'Your GitHub token stopped working' })
}

function allClear(page: Page) {
  return page.locator('.section-title', { hasText: 'All clear' })
}

test.describe('a token GitHub stops accepting', () => {
  test.use({ seed: dashboardSeed() })

  test('a token rejected mid-session stops the polling, and a reload stays on recovery', async ({
    page,
    github,
  }) => {
    github.runs(REPO, [], [])
    await page.goto('./')
    await expect(allClear(page)).toBeVisible()

    github.failRuns(REPO, REJECTED)
    await page.clock.fastForward(POLL_MS)
    await expect(recoveryCard(page)).toBeVisible()
    // Both listings of the rejected poll left together; the second must have
    // arrived before the silence that follows is measured.
    await github.waitForCalls(LISTINGS, 4)

    const stored = await storedSettings(page)
    expect(typeof stored.tokenRejectedAt, 'tokenRejectedAt').toBe('number')
    const rejectedAt = stored.tokenRejectedAt as number
    expect(rejectedAt).toBeGreaterThanOrEqual(FIXED_NOW.getTime() + POLL_MS)
    expect(credential(stored.token), 'the stored token').toBe('TOKEN')
    expect(stored.repos).toEqual([REPO])
    await expect(page.getByText(`GitHub rejected it at ${clock(rejectedAt)}.`)).toBeVisible()
    await expect(
      page.getByText('Kept in this browser: 1 repository, the Pro plan and occupancy history.', { exact: true }),
    ).toBeVisible()

    await github.expectNoNewCalls(async () => {
      await page.clock.fastForward(60_000)
    })

    await github.expectNoNewCalls(async () => {
      await page.reload()
      await expect(recoveryCard(page)).toBeVisible()
    })
    await expect(page.getByText(`GitHub rejected it at ${clock(rejectedAt)}.`)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reconnect' })).toBeDisabled()
  })

  test('a new token for the same account goes straight back to the dashboard and replaces the old one', async ({
    page,
    github,
  }) => {
    github.failRuns(REPO, REJECTED)
    await page.goto('./')
    await expect(recoveryCard(page)).toBeVisible()
    await github.waitForCalls(LISTINGS, 2)

    github.user('octocat')
    github.probe(REPO)
    github.runs(REPO, [], [])
    const reconnectedAt = github.calls.length
    await page.getByLabel('Personal access token').fill(NEW_TOKEN)
    await page.getByRole('button', { name: 'Reconnect' }).click()

    await expect(allClear(page)).toBeVisible()
    const firstPoll = github.callsTo(LISTINGS).length
    await page.clock.fastForward(POLL_MS)
    await github.waitForCalls(LISTINGS, firstPoll + 2)

    const since = github.calls.slice(reconnectedAt)
    expect(requests(since.slice(0, 2))).toEqual(['GET /user', 'GET /repos/acme/app/actions/runs?per_page=1'])
    expect(requests(since.slice(2)).every((r) => LISTINGS.test(r)), requests(since).join('\n')).toBe(true)
    expect(since.map(bearer)).toEqual(since.map(() => 'NEW_TOKEN'))

    const stored = await storedSettings(page)
    expect(credential(stored.token), 'the stored token').toBe('NEW_TOKEN')
    expect(stored.tokenRejectedAt).toBeNull()
    expect(stored.login).toBe('octocat')
    expect(stored.repos).toEqual([REPO])
    expect(stored.plan).toBe('pro')
  })
})

test.describe('a browser that was left on recovery', () => {
  test.use({ seed: dashboardSeed({ tokenRejectedAt: REJECTED_AT }) })

  test('a new token for another account goes back through choosing repositories', async ({ page, github }) => {
    github.user('someone-else')
    github.repos([repo('other/lib')])

    await page.goto('./')
    await expect(recoveryCard(page)).toBeVisible()
    const field = page.getByLabel('Personal access token')
    await field.fill(NEW_TOKEN)
    await field.press('Enter')

    await expect(page.getByText('Connected as someone-else. Choose repositories below.', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Repositories to watch' })).toBeVisible()
    await expect(page.getByRole('checkbox', { name: 'other/lib public', exact: true })).toBeVisible()
    await github.expectNoNewCalls(async () => {})
    // Another account's token is not tried against the old account's repositories.
    expect(requests(github.calls)).toEqual(['GET /user', `GET ${REPOS_PATH}`])

    // Nothing is replaced until the reader has chosen what the new token watches.
    let stored = await storedSettings(page)
    expect(credential(stored.token), 'the stored token').toBe('TOKEN')
    expect(stored.tokenRejectedAt).toBe(REJECTED_AT)

    github.probe(ref('other/lib'))
    github.runs(ref('other/lib'), [], [])
    await page.getByRole('button', { name: 'Clear', exact: true }).click()
    await page.getByRole('checkbox', { name: 'other/lib public', exact: true }).check()
    await page.getByRole('button', { name: 'Open dashboard' }).click()
    await expect(allClear(page)).toBeVisible()

    stored = await storedSettings(page)
    expect(credential(stored.token), 'the stored token').toBe('NEW_TOKEN')
    expect(stored.login).toBe('someone-else')
    expect(stored.repos).toEqual([ref('other/lib')])
    expect(stored.tokenRejectedAt).toBeNull()
    expect(github.calls.map(bearer)).toEqual(github.calls.map(() => 'NEW_TOKEN'))
  })

  test('a replacement token whose repository list fails to load can be tried again without pasting it again', async ({
    page,
    github,
  }) => {
    github.user('someone-else')
    github.on(/\/user\/repos\?/, json({ message: 'Server Error' }, { status: 502 }))

    await page.goto('./')
    await expect(recoveryCard(page)).toBeVisible()
    const field = page.getByLabel('Personal access token')
    await field.fill(NEW_TOKEN)
    await field.press('Enter')

    await expect(page.getByText('Server Error', { exact: true })).toBeVisible()
    await expect.poll(async () => credential(await field.inputValue())).toBe('NEW_TOKEN')

    github.repos([repo('other/lib')])
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'other/lib public', exact: true })).toBeVisible()
    await expect(field).toHaveValue('')
    expect(requests(github.calls)).toEqual(['GET /user', `GET ${REPOS_PATH}`, 'GET /user', `GET ${REPOS_PATH}`])
  })

  test('a replacement token GitHub also rejects leaves the page on recovery', async ({ page, github }) => {
    github.on(/\/user$/, REJECTED)

    await page.goto('./')
    await expect(recoveryCard(page)).toBeVisible()
    await expect(page.getByText(`GitHub rejected it at ${clock(REJECTED_AT)}.`)).toBeVisible()
    await page.getByLabel('Personal access token').fill(NEW_TOKEN)
    await page.getByRole('button', { name: 'Reconnect' }).click()

    await expect(page.getByText('GitHub rejected that token too. Check it was copied whole.', { exact: true })).toBeVisible()
    await expect(recoveryCard(page)).toBeVisible()
    await expect(page.getByText(/^Connected as/)).toHaveCount(0)
    await github.expectNoNewCalls(async () => {
      await page.clock.fastForward(60_000)
    })
    expect(requests(github.calls)).toEqual(['GET /user'])
    expect(github.calls.map(bearer)).toEqual(['NEW_TOKEN'])

    const stored = await storedSettings(page)
    expect(credential(stored.token), 'the stored token').toBe('TOKEN')
    expect(stored.tokenRejectedAt).toBe(REJECTED_AT)
  })
})
