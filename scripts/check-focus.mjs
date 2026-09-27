#!/usr/bin/env node
/**
 * Fails when any test is skipped, focused, marked as expected to fail, or
 * retried.
 *
 * A skipped or focused test turns the rest of verify green without running
 * what it claims to. An expected failure turns a broken test green, and a
 * retry turns a flaky one green without anyone deciding it was fine. This is
 * the check that defends the others, so verify runs it first.
 *
 * Scans the unit tests, the browser tests, both runners' configs and the npm
 * scripts, since a flag can do the same damage from any of them.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOTS = ['tests', 'e2e']
const CONFIGS = ['playwright.config.ts', 'vitest.config.ts']

const PATTERNS = [
  // it.skip, describe.only, it.skip.each, it.skipIf(c), test.fixme, it.fails...
  { name: 'skipped, focused or expected to fail', re: /\.(?:skip|only|todo|fixme|fails?|skipIf|runIf)\b/ },
  { name: 'skipped or focused', re: /\b(?:xit|xtest|xdescribe|fit|ftest|fdescribe)\s*\(/ },
  { name: 'retried', re: /\bretr(?:y|ies)\s*:\s*[1-9]/ },
  { name: 'retried', re: /--retries?[= ]?[1-9]/ },
]

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) yield path
  }
}

async function readIfPresent(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

const violations = []
const testFiles = Object.fromEntries(ROOTS.map((root) => [root, 0]))

function scan(label, text) {
  text.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) violations.push(`${label}:${i + 1}  ${name}  ${line.trim()}`)
    }
  })
}

for (const root of ROOTS) {
  try {
    for await (const path of walk(root)) {
      if (/\.(test|spec)\.ts$/.test(path)) testFiles[root]++
      scan(path.split('\\').join('/'), await readFile(path, 'utf8'))
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

for (const config of CONFIGS) {
  const text = await readIfPresent(config)
  if (text !== null) scan(config, text)
}

const pkg = await readIfPresent('package.json')
if (pkg !== null) {
  for (const [name, command] of Object.entries(JSON.parse(pkg).scripts ?? {})) {
    scan(`package.json scripts.${name}`, command)
  }
}

// A check that scanned nothing passes for the wrong reason, as it would if a
// folder of tests were renamed.
for (const [root, count] of Object.entries(testFiles)) {
  if (count === 0) violations.push(`${root}/  no test files found to check`)
}

if (violations.length > 0) {
  console.error('Tests that would not run, or not count, as written:\n')
  for (const v of violations) console.error(`  ${v}`)
  console.error('\nRun every test, once, every time.')
  process.exit(1)
}

const total = Object.values(testFiles).reduce((a, b) => a + b, 0)
console.log(`ok    no skipped, focused or retried tests in ${total} test files`)
