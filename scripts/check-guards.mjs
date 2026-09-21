#!/usr/bin/env node
/**
 * Proves that the two build-time security checks can fail.
 *
 * A guard nobody has seen fail is indistinguishable from one that cannot. This
 * runs each against input it must reject and fails if it is accepted: the real
 * build with its Content Security Policy removed, and each form of calling
 * fetch outside the API client. Needs dist/, so it runs after the build.
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const CHECK_CSP = resolve('scripts/check-csp.mjs')
const CHECK_FETCH = resolve('scripts/check-fetch.mjs')

const FETCH_FORMS = [
  'fetch(url)',
  'globalThis.fetch(url)',
  'window.fetch(url)',
  'self.fetch(url)',
  'const f = fetch; f(url)',
]

const failures = []

function mustReject(label, script, args, cwd) {
  const { status } = spawnSync(process.execPath, [script, ...args], { cwd, stdio: 'ignore' })
  if (status === 1) console.log(`ok    rejected: ${label}`)
  else failures.push(`${label} (exit ${status})`)
}

const work = await mkdtemp(join(tmpdir(), 'actiondash-guards-'))
try {
  const html = await readFile('dist/index.html', 'utf8')
  const stripped = html.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/i, '')
  if (stripped === html) failures.push('could not find the CSP meta tag to remove from dist/index.html')
  await writeFile(join(work, 'index.html'), stripped)
  mustReject('build without its Content Security Policy', CHECK_CSP, [work])

  for (const form of FETCH_FORMS) {
    const root = join(work, 'fetch', String(FETCH_FORMS.indexOf(form)))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'stray.ts'), `export const x = (url: string) => ${form}\n`)
    mustReject(`network call as ${form}`, CHECK_FETCH, [], root)
  }
} finally {
  await rm(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error('\nA security check accepted input it must reject:')
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}
