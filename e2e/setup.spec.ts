import type { Page } from '@playwright/test'
import type { RepoRef } from '../src/github/types'
import { deferred, json } from '../tests/replies'
import { expect, test } from './fixtures'
import { bearer, credential, ref, repo, REPOS_PATH, requests } from './scenarios'
import { KEYS, TOKEN } from './seed'

/**
 * A new visitor's way in: checking a token, choosing repositories and a plan,
 * and the checks that stand between them and a dashboard that cannot poll.
 */

async function storedSettings(page: Page): Promise<Record<string, unknown> | null> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), KEYS.settings)
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>)
}

function byName(list: unknown): RepoRef[] {
  return [...(list as RepoRef[])].sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`))
}

function repoBox(page: Page, fullName: string, visibility: 'public' | 'private' = 'public') {
  return page.getByRole('checkbox', { name: `${fullName} ${visibility}`, exact: true })
}

async function connect(page: Page): Promise<void> {
  await page.goto('./')
  await page.getByLabel('Personal access token').fill(TOKEN)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByText('Connected as octocat.', { exact: true })).toBeVisible()
}

const PROBES = /\/actions\/runs\?per_page=1$/

test('connecting checks the token, lists its repositories and clears the field', async ({ page, github }) => {
  github.user()
  github.repos([repo('acme/app'), repo('acme/site', { private: true }), repo('acme/legacy', { archived: true })])

  await connect(page)

  await expect(page.getByLabel('Personal access token')).toHaveValue('')
  await expect(page.getByRole('checkbox')).toHaveCount(2)
  await expect(repoBox(page, 'acme/app')).not.toBeChecked()
  await expect(repoBox(page, 'acme/site', 'private')).not.toBeChecked()
  // A repository that settles after the list renders would still count.
  await github.expectNoNewCalls(async () => {})
  expect(requests(github.calls)).toEqual(['GET /user', `GET ${REPOS_PATH}`])
  expect(github.calls.map(bearer)).toEqual(['TOKEN', 'TOKEN'])
})

test('a token is checked once, however often Enter is pressed', async ({ page, github }) => {
  const user = deferred()
  github.on(/\/user$/, user.reply)
  github.repos([repo('acme/app')])

  await page.goto('./')
  const field = page.getByLabel('Personal access token')
  await field.fill(TOKEN)
  await field.press('Enter')
  await github.waitForCalls(/\/user$/)
  await github.expectNoNewCalls(() => field.press('Enter'))

  user.resolve(json({ login: 'octocat', name: null }))
  await expect(page.getByText('Connected as octocat.', { exact: true })).toBeVisible()
  await github.expectNoNewCalls(async () => {})
  expect(requests(github.calls)).toEqual(['GET /user', `GET ${REPOS_PATH}`])
})

test('choosing repositories and a plan opens the dashboard, and a reload goes straight back to it', async ({
  page,
  github,
}) => {
  github.user()
  github.repos([repo('acme/app'), repo('acme/site', { private: true }), repo('acme/docs'), repo('acme/website')])
  github.probe(ref('acme/app'))
  github.probe(ref('acme/site'))
  github.runs(ref('acme/app'), [], [])
  github.runs(ref('acme/site'), [], [])

  await connect(page)

  const filter = page.getByLabel('Filter repositories')
  await filter.fill('site')
  await expect(page.getByRole('checkbox')).toHaveCount(2)
  await expect(repoBox(page, 'acme/website')).toBeVisible()
  await repoBox(page, 'acme/site', 'private').check()
  await filter.fill('')
  await expect(page.getByRole('checkbox')).toHaveCount(4)
  await repoBox(page, 'acme/app').check()
  await expect(page.getByText('2 selected: acme/site, acme/app', { exact: true })).toBeVisible()

  await page.getByLabel('Plan').selectOption('pro')
  await page.getByRole('button', { name: 'Open dashboard' }).click()

  const allClear = page.locator('.section-title', { hasText: 'All clear' })
  await expect(allClear).toBeVisible()
  expect(github.callsTo(PROBES).map((c) => c.path).sort()).toEqual([
    '/repos/acme/app/actions/runs?per_page=1',
    '/repos/acme/site/actions/runs?per_page=1',
  ])

  const stored = await storedSettings(page)
  expect(credential(stored?.token), 'the stored token').toBe('TOKEN')
  expect(byName(stored?.repos)).toEqual([ref('acme/app'), ref('acme/site')])
  expect(stored?.plan).toBe('pro')
  expect(stored?.login).toBe('octocat')
  expect(stored?.tokenRejectedAt).toBeNull()

  const beforeReload = github.calls.length
  await page.reload()
  await expect(allClear).toBeVisible()
  await expect(page.getByLabel('Personal access token')).toHaveCount(0)
  // Lets anything the dashboard asked for on the way in arrive before looking.
  await github.expectNoNewCalls(async () => {})
  const afterReload = requests(github.calls.slice(beforeReload))
  expect(afterReload.length).toBeGreaterThan(0)
  expect(afterReload.filter((r) => !/\/actions\/runs\?status=/.test(r))).toEqual([])
})

test('the selection and the plan hold still while each repository is checked', async ({ page, github }) => {
  github.user()
  github.repos([repo('acme/app'), repo('acme/site')])
  const probe = deferred()
  github.probe(ref('acme/app'), probe.reply)
  github.runs(ref('acme/app'), [], [])

  await connect(page)
  await repoBox(page, 'acme/app').check()
  await page.getByRole('button', { name: 'Open dashboard' }).click()
  await github.waitForCalls(PROBES)

  await expect(repoBox(page, 'acme/app')).toBeDisabled()
  await expect(repoBox(page, 'acme/site')).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Select all shown' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Clear', exact: true })).toBeDisabled()
  await expect(page.getByLabel('Add a repository by name')).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeDisabled()
  await expect(page.getByLabel('Plan')).toBeDisabled()
  // Narrowing the list changes nothing that is being checked.
  await expect(page.getByLabel('Filter repositories')).toBeEnabled()

  probe.resolve(json({ total_count: 0, workflow_runs: [] }))
  await expect(page.locator('.section-title', { hasText: 'All clear' })).toBeVisible()
  expect(github.callsTo(PROBES).map((c) => c.path)).toEqual(['/repos/acme/app/actions/runs?per_page=1'])
})

test('a rejected token is never stored', async ({ page, github }) => {
  github.on(/\/user$/, json({ message: 'Bad credentials' }, { status: 401 }))

  await page.goto('./')
  const field = page.getByLabel('Personal access token')
  await field.fill(TOKEN)
  await field.press('Enter')

  await expect(
    page.getByText('GitHub rejected that token. Check it was copied whole and has not expired.', { exact: true }),
  ).toBeVisible()
  await expect(page.getByText(/^Connected as/)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '2. Repositories to watch' })).toHaveCount(0)
  await github.expectNoNewCalls(async () => {})
  expect(requests(github.calls)).toEqual(['GET /user'])

  const holding = await page.evaluate((secret) => {
    const keys = (storage: Storage) => Object.keys(storage).filter((k) => storage.getItem(k)?.includes(secret))
    return [...keys(localStorage), ...keys(sessionStorage)]
  }, TOKEN)
  expect(holding, 'storage keys holding the rejected token').toEqual([])

  // A token kept anywhere the page reads on load would be checked again here.
  await github.expectNoNewCalls(async () => {
    await page.reload()
    await expect(page.getByLabel('Personal access token')).toHaveValue('')
  })
  await expect(page.getByRole('button', { name: 'Use stored token' })).toHaveCount(0)
})

test('a repository list that fails to load can be asked for again without pasting the token again', async ({
  page,
  github,
}) => {
  github.user()
  github.on(/\/user\/repos\?/, json({ message: 'Server Error' }, { status: 502 }))

  await page.goto('./')
  const field = page.getByLabel('Personal access token')
  await field.fill(TOKEN)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()

  await expect(page.getByText('Server Error', { exact: true })).toBeVisible()
  // GitHub accepted the token; only the list failed. It is still there to try again with.
  await expect.poll(async () => credential(await field.inputValue())).toBe('TOKEN')

  github.repos([repo('acme/app')])
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByText('Connected as octocat.', { exact: true })).toBeVisible()
  await expect(repoBox(page, 'acme/app')).toBeVisible()
  await expect(field).toHaveValue('')
  expect(requests(github.calls)).toEqual(['GET /user', `GET ${REPOS_PATH}`, 'GET /user', `GET ${REPOS_PATH}`])
})

test('a repository the token cannot read is named, and deselecting it lets the dashboard open', async ({
  page,
  github,
}) => {
  github.user()
  github.repos([repo('acme/app'), repo('acme/site', { private: true })])
  github.probe(ref('acme/app'))
  github.probe(ref('acme/site'), json({ message: 'Not Found' }, { status: 404 }))
  github.runs(ref('acme/app'), [], [])

  await connect(page)
  await page.getByRole('button', { name: 'Select all shown' }).click()
  await page.getByRole('button', { name: 'Open dashboard' }).click()

  const alert = page.getByRole('alert')
  await expect(alert).toContainText(
    'The token cannot read Actions on acme/site: not found; the token may not include it.',
  )
  await expect(alert).not.toContainText('acme/app')
  await expect(page.getByRole('button', { name: 'Open dashboard' })).toBeVisible()
  expect((await storedSettings(page))?.repos ?? [], 'repositories saved as watched').toEqual([])

  await alert.getByRole('button', { name: 'Deselect it' }).click()
  await expect(alert).toHaveCount(0)
  await expect(repoBox(page, 'acme/site', 'private')).not.toBeChecked()
  await expect(repoBox(page, 'acme/app')).toBeChecked()

  await page.getByRole('button', { name: 'Open dashboard' }).click()
  await expect(page.locator('.section-title', { hasText: 'All clear' })).toBeVisible()
  expect(github.callsTo(/\/repos\/acme\/site\/actions\/runs\?per_page=1$/)).toHaveLength(1)
  expect(github.callsTo(/\/repos\/acme\/app\/actions\/runs\?per_page=1$/)).toHaveLength(2)
  expect((await storedSettings(page))?.repos).toEqual([ref('acme/app')])
})

test('a repository added by name or address is watched, and a malformed one is refused', async ({
  page,
  github,
}) => {
  github.user()
  github.repos([repo('acme/app')])
  github.probe(ref('acme/tools'))
  github.probe(ref('acme/infra'))
  github.runs(ref('acme/tools'), [], [])
  github.runs(ref('acme/infra'), [], [])

  await connect(page)

  const byNameField = page.getByLabel('Add a repository by name')
  await byNameField.fill('nonsense')
  await byNameField.press('Enter')
  const refusal = page.getByText('Enter a repository as owner/name.', { exact: true })
  await expect(refusal).toBeVisible()
  await expect(page.getByText('0 selected', { exact: true })).toBeVisible()

  await byNameField.fill('acme/tools')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(refusal).toHaveCount(0)
  await expect(byNameField).toHaveValue('')
  await expect(page.getByText('1 selected: acme/tools', { exact: true })).toBeVisible()

  await byNameField.fill('https://github.com/acme/infra.git')
  await byNameField.press('Enter')
  await expect(page.getByText('2 selected: acme/tools, acme/infra', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Open dashboard' }).click()
  await expect(page.locator('.section-title', { hasText: 'All clear' })).toBeVisible()
  expect(byName((await storedSettings(page))?.repos)).toEqual([ref('acme/infra'), ref('acme/tools')])
})

test('repositories from two accounts are flagged, and keeping one account drops the other', async ({
  page,
  github,
}) => {
  github.user()
  // The smaller account is listed first, so keeping "the first" would keep the wrong one.
  github.repos([repo('other/lib'), repo('acme/app'), repo('acme/site')])

  await connect(page)
  await page.getByRole('button', { name: 'Select all shown' }).click()

  const warning = page.locator('.banner.warn')
  await expect(warning).toContainText('These repositories belong to 2 accounts: acme and other.')
  await warning.getByRole('button', { name: 'Keep only acme' }).click()

  await expect(warning).toHaveCount(0)
  await expect(repoBox(page, 'acme/app')).toBeChecked()
  await expect(repoBox(page, 'acme/site')).toBeChecked()
  await expect(repoBox(page, 'other/lib')).not.toBeChecked()
  await expect(page.getByText('2 selected: acme/app, acme/site', { exact: true })).toBeVisible()
})

test('the token field says what kind of token was pasted, before anything is sent', async ({ page, github }) => {
  await page.goto('./')
  const field = page.getByLabel('Personal access token')
  const classic = page.getByText(/^That is a classic token\./)
  const oauth = page.getByText(/^That looks like an OAuth or CLI token/)
  const fineGrained = page.getByText('Fine-grained token.', { exact: true })

  await field.fill('ghp_notARealTokenOnlyTheClassicPrefix00')
  await expect(classic).toBeVisible()
  await expect(oauth).toHaveCount(0)
  await expect(fineGrained).toHaveCount(0)

  await field.fill('gho_notARealTokenOnlyTheOAuthPrefix')
  await expect(oauth).toBeVisible()
  await expect(classic).toHaveCount(0)

  await field.fill('github_pat_notARealTokenOnlyThePrefix')
  await expect(fineGrained).toBeVisible()
  await expect(classic).toHaveCount(0)
  await expect(oauth).toHaveCount(0)

  expect(github.calls).toEqual([])
})
