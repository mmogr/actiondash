import type { RepoRef, WorkflowJob, WorkflowRun } from '../src/github/types'
import { makeJob, makeRun } from '../tests/helpers'
import { json } from '../tests/replies'
import { expect, test } from './fixtures'
import { dashboardSeed, REPO, type Seed } from './seed'

/**
 * Runs drawn as job graphs: a release in acme/app whose two macOS builds
 * wait behind another repository's UI tests, with three stages still to come
 * that GitHub has not created yet.
 */

const IOS: RepoRef = { owner: 'acme', name: 'ios' }
const PATH = '.github/workflows/release.yml'
const SHA = 'c'.repeat(40)
const CONTENTS = /\/contents\//

const RELEASE = `name: Release
on: workflow_dispatch
jobs:
  meta:
    name: Prepare
    runs-on: ubuntu-24.04
    steps: [{ run: echo }]
  build:
    name: Build \${{ matrix.target }}
    needs: meta
    strategy:
      matrix:
        target: [x86_64-linux, aarch64-linux]
    runs-on: ubuntu-24.04
    steps: [{ run: make }]
  build-mac:
    name: Build GUI \${{ matrix.arch }}
    needs: meta
    strategy:
      matrix:
        arch: [aarch64, x86_64]
    runs-on: macos-15
    steps: [{ run: make }]
  publish:
    name: Publish the release
    needs: [build, build-mac]
    runs-on: ubuntu-24.04
    steps: [{ run: publish }]
  homebrew:
    name: Update the Homebrew tap
    needs: publish
    runs-on: ubuntu-24.04
    steps: [{ run: tap }]
  docs:
    name: Deploy documentation
    needs: publish
    runs-on: ubuntu-24.04
    steps: [{ run: deploy }]
`

const release: WorkflowRun = makeRun({
  id: 412,
  run_number: 412,
  name: 'Release',
  status: 'in_progress',
  event: 'workflow_dispatch',
  head_branch: 'main',
  head_sha: SHA,
  path: PATH,
  actor: { login: 'octocat' },
  created_at: '2026-09-09T10:00:00Z',
})

const at = (hhmmss: string) => `2026-09-09T${hhmmss}Z`

function releaseJobs(): WorkflowJob[] {
  const job = (id: number, name: string, over: Partial<WorkflowJob>) =>
    makeJob({ id, run_id: 412, name, html_url: `https://github.com/acme/app/actions/runs/412/job/${id}`, ...over })
  return [
    job(4121, 'Prepare', { status: 'completed', conclusion: 'success', labels: ['ubuntu-24.04'], created_at: at('10:00:00'), started_at: at('10:00:05'), completed_at: at('10:01:00') }),
    job(4122, 'Build x86_64-linux', { status: 'in_progress', labels: ['ubuntu-24.04'], created_at: at('10:01:00'), started_at: at('10:01:10') }),
    job(4123, 'Build aarch64-linux', { status: 'in_progress', labels: ['ubuntu-24.04'], created_at: at('10:01:00'), started_at: at('10:01:10') }),
    job(4124, 'Build GUI aarch64', { status: 'queued', labels: ['macos-15'], created_at: at('10:01:00') }),
    job(4125, 'Build GUI x86_64', { status: 'queued', labels: ['macos-15'], created_at: at('10:01:00') }),
  ]
}

const uiTests: WorkflowRun = makeRun({ id: 213, run_number: 213, name: 'UI Tests', status: 'in_progress', head_branch: 'feature', created_at: at('09:50:00'), repoOwner: 'acme', repoName: 'ios' })

function uiJobs(): WorkflowJob[] {
  const names = ['UI iPhone', 'UI iPad', 'UI dark', 'UI light', 'Analyze', 'UI Mac', 'Snapshots', 'Lint']
  return names.map((name, i) =>
    makeJob({
      id: 2130 + i,
      run_id: 213,
      name,
      labels: ['macos-15'],
      status: i < 5 ? 'in_progress' : 'queued',
      created_at: at('09:52:00'),
      started_at: i < 5 ? at('09:52:10') : null,
      html_url: `https://github.com/acme/ios/actions/runs/213/job/${2130 + i}`,
    }),
  )
}

function learned(repo: RepoRef, entries: Record<string, [minutes: number, cls: string]>) {
  return Object.fromEntries(
    Object.entries(entries).map(([name, [minutes, cls]], i) => [
      `${repo.owner}/${repo.name}::${name}`,
      { secs: [minutes * 60], ids: [900_000 + i + name.length * 1000], cls, seenAt: Date.parse('2026-09-09T09:00:00Z') },
    ]),
  )
}

function seed(graphRepos: string[]): Seed {
  return {
    ...dashboardSeed({ repos: [REPO, IOS], graphRepos }),
    durations: {
      ...learned(REPO, {
        'Build GUI aarch64': [24, 'macos'],
        'Build GUI x86_64': [22, 'macos'],
        'Build x86_64-linux': [8, 'linux'],
        'Build aarch64-linux': [9, 'linux'],
        'Publish the release': [2, 'linux'],
        'Update the Homebrew tap': [1, 'linux'],
        'Deploy documentation': [3, 'linux'],
      }),
      ...learned(IOS, { 'UI iPhone': [30, 'macos'], 'UI iPad': [35, 'macos'], 'UI dark': [40, 'macos'], 'UI light': [45, 'macos'], Analyze: [60, 'macos'], 'UI Mac': [20, 'macos'], Snapshots: [15, 'macos'], Lint: [5, 'macos'] }),
    },
  }
}

function scriptMorning(github: import('./github').BrowserGitHub, jobs = releaseJobs()) {
  github.runs(REPO, [], [release]).runs(IOS, [], [uiTests]).jobs(412, jobs).jobs(213, uiJobs())
}

test.describe('with graphs on for acme/app', () => {
  test.use({ seed: seed(['acme/app']) })

  test('draws the run as a graph, with the stages GitHub has not created yet', async ({ page, github }) => {
    scriptMorning(github)
    github.workflowFile(REPO, PATH, RELEASE)
    await page.goto('./')

    const graph = page.getByRole('group', { name: 'Jobs of app #412, by stage' })
    await expect(graph).toBeVisible()
    const node = (name: string) => graph.locator('.gnode', { has: page.locator('.gnode-name', { hasText: name }) })
    await expect(node('Build GUI')).toHaveClass(/st-waiting/)
    await expect(node('Build GUI').locator('.gnode-count')).toHaveText('×2')
    // Behind the three of acme/ios that were waiting first.
    await expect(node('Build GUI').locator('.gnode-detail')).toContainText('4th–5th in line')
    await expect(node('Publish the release')).toHaveClass(/st-future/)
    await expect(node('Publish the release').locator('.gnode-detail')).toContainText(/^starts ~\d\d:\d\d$/)
    // The finished first stage folds away, so the graph shows what is left.
    await expect(graph.locator('.st-folded')).toContainText('1 job passed')

    // The time is for the whole run, jobs not created yet included.
    await expect(page.locator('.yours-when')).toContainText(/^done ~\d\d:\d\d/)
    // Read once, at the run's own commit.
    expect(github.callsTo(CONTENTS).map((c) => c.path)).toEqual([`/repos/acme/app/contents/${PATH}?ref=${SHA}`])
  })

  test('tapping a waiting job says who is ahead of it, and Escape puts focus back', async ({ page, github }) => {
    scriptMorning(github)
    github.workflowFile(REPO, PATH, RELEASE)
    await page.goto('./')

    const node = page.locator('.gnode', { has: page.locator('.gnode-name', { hasText: 'Build GUI' }) })
    await node.click()
    const sheet = page.getByRole('complementary', { name: 'Build GUI ×2' })
    await expect(sheet).toBeVisible()
    await expect(sheet.locator('.why-big')).toContainText('4th in line')
    await expect(sheet.locator('.why-ahead-row')).toHaveText([/ios #213.*3$/])
    await expect(sheet.getByRole('img', { name: /When each slot is expected to free/ })).toBeVisible()
    // The run holding the line is marked where it is drawn.
    await expect(page.locator('.group[data-run="213"] .ahead-note')).toHaveText('3 jobs ahead of the one you picked')

    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(node).toBeFocused()
  })

  test('a stage still to come says what it waits for', async ({ page, github }) => {
    scriptMorning(github)
    github.workflowFile(REPO, PATH, RELEASE)
    await page.goto('./')

    await page.locator('.gnode', { has: page.locator('.gnode-name', { hasText: 'Publish the release' }) }).click()
    const sheet = page.getByRole('complementary', { name: 'Publish the release' })
    await expect(sheet.locator('.why-kicker').first()).toHaveText('Not created yet')
    await expect(sheet).toContainText('GitHub creates it when Build and Build GUI finish')
  })

  test('a workflow file that does not explain the run is not drawn', async ({ page, github }) => {
    scriptMorning(github)
    const renamed = RELEASE.replace('name: Prepare', 'name: Get ready')
    github.workflowFile(REPO, PATH, renamed, { ref: SHA })
    github.workflowFile(REPO, PATH, renamed, { ref: null, etag: '"blob0"' })
    await page.goto('./')

    await expect(page.locator('.group[data-run="412"]').first()).toBeVisible()
    await github.waitForCalls(CONTENTS, 2)
    // The commit's copy, then the default branch's, then nothing more.
    expect(github.callsTo(CONTENTS).map((c) => c.path.includes('?ref='))).toEqual([true, false])
    await expect(page.locator('.gnode')).toHaveCount(0)
    await expect(page.locator('.yours-when')).toContainText('current jobs done')
  })

  test('a token that cannot read the workflow files is named in Settings', async ({ page, github }) => {
    scriptMorning(github)
    github.on(CONTENTS, json({ message: 'Resource not accessible by personal access token' }, { status: 403 }))
    await page.goto('./')
    await github.waitForCalls(CONTENTS)
    await expect(page.locator('.gnode')).toHaveCount(0)

    await page.goto('./#settings')
    const row = page.locator('.watch-list li', { hasText: 'acme/app' }).filter({ has: page.getByRole('checkbox') })
    await expect(row.locator('.watch-problem')).toHaveText('cannot read its workflow files: the token needs Contents: read')
  })
})

test.describe('with graphs off', () => {
  test.use({ seed: seed([]) })

  test('reads no workflow file and keeps the plain job list', async ({ page, github }) => {
    scriptMorning(github)
    await page.goto('./')
    await expect(page.locator('.group[data-run="412"]').first()).toBeVisible()
    await expect(page.locator('.yours-when')).toContainText('current jobs done')
    await expect(page.locator('.gnode')).toHaveCount(0)
    expect(github.callsTo(CONTENTS)).toEqual([])
  })

  test('turning a repository on in Settings says what it grants, then reads its file', async ({ page, github }) => {
    scriptMorning(github)
    github.workflowFile(REPO, PATH, RELEASE)
    await page.goto('./#settings')

    const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Job graphs' }) })
    await expect(card).toContainText('That permission can read all of the repository\'s code.')
    await card.getByRole('checkbox', { name: 'acme/app' }).check()
    // A check this soon after the last is refused, so the next scheduled one reads it.
    await page.clock.runFor(16_000)
    await github.waitForCalls(CONTENTS)

    await page.goto('./#now')
    await expect(page.getByRole('group', { name: 'Jobs of app #412, by stage' })).toBeVisible()
  })
})
