#!/usr/bin/env node
/**
 * Proves that every check in verify can fail.
 *
 * A guard nobody has seen fail is indistinguishable from one that cannot. This
 * runs each against input it must reject and fails if it is accepted:
 *
 *   - the real build with its Content Security Policy removed, and each form
 *     of calling fetch outside the API client, in the page and in the service
 *     worker;
 *   - each form of skipping, focusing or retrying a test;
 *   - the browser tests in e2e/tripwires, each written to trip one of the
 *     guards every browser test ends with, which must each fail on that guard;
 *   - copies of the real build broken the way a user would notice, each of
 *     which a named smoke test must fail.
 *
 * Needs dist/ and Chromium, so it runs last.
 */
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const CHECK_CSP = resolve('scripts/check-csp.mjs')
const CHECK_FETCH = resolve('scripts/check-fetch.mjs')
const CHECK_FOCUS = resolve('scripts/check-focus.mjs')
const PLAYWRIGHT = resolve('node_modules/.bin/playwright')

// Kept off the normal browser tests' port, so a run of those is undisturbed.
const PORT = '4181'

const FETCH_FORMS = [
  'fetch(url)',
  'globalThis.fetch(url)',
  'window.fetch(url)',
  'self.fetch(url)',
  'const f = fetch; f(url)',
]

const FOCUS_FORMS = [
  { file: 'tests/stray.test.ts', text: "it.skip('x', () => {})" },
  { file: 'tests/stray.test.ts', text: "describe.only('x', () => {})" },
  { file: 'tests/stray.test.ts', text: "it.skip.each([1])('x', () => {})" },
  { file: 'tests/stray.test.ts', text: "it.skipIf(true)('x', () => {})" },
  { file: 'tests/stray.test.ts', text: "it.runIf(false)('x', () => {})" },
  { file: 'tests/stray.test.ts', text: "it.todo('x')" },
  { file: 'tests/stray.test.ts', text: "it.fails('x', () => {})" },
  { file: 'tests/stray.test.ts', text: "xit('x', () => {})" },
  { file: 'tests/stray.test.ts', text: "fdescribe('x', () => {})" },
  { file: 'e2e/stray.spec.ts', text: "test.fixme('x', async () => {})" },
  { file: 'e2e/stray.spec.ts', text: 'test.fail()' },
  { file: 'e2e/stray.spec.ts', text: "test.describe.configure({ retries: 2 })" },
  { file: 'playwright.config.ts', text: 'export default { retries: 1 }' },
  { file: 'package.json', text: JSON.stringify({ scripts: { e2e: 'playwright test --retries=2' } }) },
]

const TRIPWIRES = ['csp', 'pageerror', 'console', 'foreign', 'unscripted', 'token', 'cors', 'asset', 'phantom']

// Each names the smoke test that must fail against the broken copy, by title.
const MUTANTS = [
  {
    label: 'a page with nowhere to mount',
    test: 'a fresh browser lands on setup and asks GitHub nothing',
    // Must be reported as the crash it is.
    tag: 'pageerror',
    break: async (dist) => edit(join(dist, 'index.html'), (html) => html.replace('id="app"', '')),
  },
  {
    label: 'a blank page',
    test: 'a fresh browser lands on setup and asks GitHub nothing',
    // Nothing throws, so the test's own assertions have to catch it.
    tag: null,
    break: async (dist) => writeFile(join(dist, await entryScript(dist)), ''),
  },
  {
    label: 'a service worker that does not parse',
    test: 'the service worker takes control without touching requests',
    break: async (dist) => edit(join(dist, 'sw.js'), (js) => `${js}\n}`),
  },
  {
    label: 'a build without its Content Security Policy',
    test: 'the policy refuses a connection to any other host',
    break: async (dist) => edit(join(dist, 'index.html'), stripCsp),
  },
]

const failures = []

function stripCsp(html) {
  return html.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/i, '')
}

async function edit(path, change) {
  const before = await readFile(path, 'utf8')
  const after = change(before)
  if (after === before) throw new Error(`could not break ${path}: nothing to change`)
  await writeFile(path, after)
}

async function entryScript(dist) {
  const html = await readFile(join(dist, 'index.html'), 'utf8')
  const src = /<script\b[^>]*type="module"[^>]*\bsrc="([^"]+)"/.exec(html)?.[1]
  if (!src) throw new Error('could not find the entry script in dist/index.html')
  return src
}

function mustReject(label, script, args, cwd) {
  const { status } = spawnSync(process.execPath, [script, ...args], { cwd, stdio: 'ignore' })
  if (status === 1) console.log(`ok    rejected: ${label}`)
  else failures.push(`${label} (exit ${status})`)
}

/**
 * Runs Playwright and returns each test's title, status and error text, from
 * its JSON report. Its output goes to the scratch folder, never over the
 * report of a real run.
 */
function playwright(work, name, env, args) {
  const out = join(work, name)
  const report = join(out, 'report.json')
  const { status } = spawnSync(PLAYWRIGHT, ['test', ...args, '--reporter=json', `--output=${join(out, 'results')}`], {
    env: { ...process.env, ...env, E2E_PORT: PORT, PLAYWRIGHT_JSON_OUTPUT_NAME: report },
    stdio: 'ignore',
    timeout: 3 * 60_000,
  })
  return readFile(report, 'utf8').then(
    (text) => ({ status, tests: flatten(JSON.parse(text)) }),
    () => ({ status, tests: [] }),
  )
}

function flatten(report) {
  const walk = (suite) => [
    ...(suite.specs ?? []).flatMap((spec) =>
      spec.tests.map((t) => {
        const result = t.results.at(-1)
        const error = (result?.errors ?? []).map((e) => e.message ?? '').join('\n')
        return { title: spec.title, status: result?.status, error: error.replace(/\x1b\[[0-9;]*m/g, '') }
      }),
    ),
    ...(suite.suites ?? []).flatMap(walk),
  ]
  return (report.suites ?? []).flatMap(walk)
}

const work = await mkdtemp(join(tmpdir(), 'actiondash-guards-'))
try {
  // ---- the build-time security checks ----

  const html = await readFile('dist/index.html', 'utf8')
  const stripped = stripCsp(html)
  if (stripped === html) failures.push('could not find the CSP meta tag to remove from dist/index.html')
  await writeFile(join(work, 'index.html'), stripped)
  mustReject('build without its Content Security Policy', CHECK_CSP, [work])

  for (const form of FETCH_FORMS) {
    const root = join(work, 'fetch', String(FETCH_FORMS.indexOf(form)))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'stray.ts'), `export const x = (url: string) => ${form}\n`)
    mustReject(`network call as ${form}`, CHECK_FETCH, [], root)
  }

  // The worker is the one script the page's policy does not cover.
  const worker = join(work, 'worker')
  await mkdir(join(worker, 'public'), { recursive: true })
  await writeFile(
    join(worker, 'public', 'sw.js'),
    "self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)))\n",
  )
  mustReject('a fetch handler in the service worker', CHECK_FETCH, [], worker)

  // ---- skipped, focused and retried tests ----

  for (const [i, { file, text }] of FOCUS_FORMS.entries()) {
    const root = join(work, 'focus', String(i))
    // A clean test in each folder, so the check cannot fail for finding none.
    await mkdir(join(root, 'tests'), { recursive: true })
    await mkdir(join(root, 'e2e'), { recursive: true })
    await writeFile(join(root, 'tests', 'clean.test.ts'), "it('x', () => {})\n")
    await writeFile(join(root, 'e2e', 'clean.spec.ts'), "test('x', async () => {})\n")
    await writeFile(join(root, file), `${text}\n`)
    mustReject(`a test written as ${text}`, CHECK_FOCUS, [], root)
  }

  // ---- the browser guards ----

  const tripped = await playwright(work, 'tripwires', { E2E_TRIPWIRES: '1' }, ['--project=tripwires'])
  const seen = tripped.tests.map((t) => /^\[(\w+)\]/.exec(t.title)?.[1])
  for (const tag of TRIPWIRES) {
    const t = tripped.tests[seen.indexOf(tag)]
    if (!t) failures.push(`no tripwire for [${tag}]`)
    else if (t.status !== 'failed') failures.push(`tripwire did not trip: ${t.title} (${t.status})`)
    else if (!t.error.includes(`"[${tag}]`)) failures.push(`tripwire failed on something else: ${t.title}\n${t.error}`)
    else console.log(`ok    tripped: ${t.title}`)
  }
  if (tripped.tests.length !== TRIPWIRES.length) {
    failures.push(`expected ${TRIPWIRES.length} tripwires, found ${tripped.tests.length}`)
  }

  // ---- broken builds ----

  for (const [i, mutant] of MUTANTS.entries()) {
    const dist = join(work, 'mutants', String(i))
    await cp('dist', dist, { recursive: true })
    await mutant.break(dist)
    const run = await playwright(work, `mutant-${i}`, { E2E_DIST: dist }, [
      'e2e/smoke.spec.ts',
      '--project=desktop',
      '--grep',
      mutant.test,
    ])
    const [t, ...extra] = run.tests
    if (!t || extra.length > 0) {
      failures.push(`${mutant.label}: expected one test named "${mutant.test}", found ${run.tests.length}`)
    } else if (t.status !== 'failed') {
      failures.push(`${mutant.label} survived: "${t.title}" ${t.status}`)
    } else if (mutant.tag && !t.error.includes(`"[${mutant.tag}]`)) {
      failures.push(`${mutant.label}: failed, but not with [${mutant.tag}]\n${t.error}`)
    } else if (mutant.tag === null && /"\[\w+\]/.test(t.error)) {
      failures.push(`${mutant.label}: caught only by a guard, not by the test's own assertions\n${t.error}`)
    } else {
      console.log(`ok    caught: ${mutant.label}`)
    }
  }
} finally {
  await rm(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error('\nA check accepted input it must reject:')
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}
