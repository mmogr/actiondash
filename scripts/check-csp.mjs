#!/usr/bin/env node
/**
 * Verifies the security properties of the production build.
 *
 * The Content Security Policy is what stops the stored GitHub token from being
 * sent anywhere but GitHub, so a build that quietly loses it, or that gains an
 * inline script, must fail rather than ship.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const DIST = process.argv[2] ?? 'dist'
const html = await readFile(join(DIST, 'index.html'), 'utf8')

const failures = []
const checks = []

/**
 * HTML attribute values are entity-encoded on the way out and decoded by the
 * parser on the way in, so the policy has to be decoded before it is compared
 * against what the browser will actually enforce.
 */
function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function check(label, ok, detail) {
  checks.push({ label, ok })
  if (!ok) failures.push(detail ?? label)
}

// ---- the policy is present, and present first ----

const metaMatch = html.match(
  /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=["']([^"']+)["']\s*\/?>/i,
)
check('CSP meta tag present', Boolean(metaMatch))

if (!metaMatch) {
  report()
}

const csp = decodeEntities(metaMatch[1])
const firstScript = html.search(/<script\b/i)
const firstLink = html.search(/<link\b/i)
const cspAt = html.indexOf(metaMatch[0])

check(
  'CSP precedes every script and link',
  (firstScript === -1 || cspAt < firstScript) && (firstLink === -1 || cspAt < firstLink),
  'CSP meta must be the first thing in <head>; a policy after a script does not govern it',
)

// ---- the policy says what it must say ----

const directives = new Map(
  csp
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const [name, ...values] = d.split(/\s+/)
      return [name.toLowerCase(), values]
    }),
)

const REQUIRED = {
  'default-src': ["'none'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'connect-src': ['https://api.github.com'],
  'img-src': ["'self'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'object-src': ["'none'"],
}

for (const [name, expected] of Object.entries(REQUIRED)) {
  const actual = directives.get(name)
  check(
    `${name} is exactly ${expected.join(' ')}`,
    actual !== undefined && actual.join(' ') === expected.join(' '),
    `${name} should be "${expected.join(' ')}" but was "${actual ? actual.join(' ') : '(absent)'}"`,
  )
}

check(
  "no 'unsafe-inline' anywhere in the production policy",
  !csp.includes('unsafe-inline'),
)
check("no 'unsafe-eval' anywhere in the production policy", !csp.includes('unsafe-eval'))
check('no wildcard source', !/(^|\s)\*(\s|;|$)/.test(csp))
check('no localhost or websocket source leaked from the dev policy', !/localhost|ws:\/\//.test(csp))

const connectSrc = directives.get('connect-src') ?? []
check(
  'connect-src admits api.github.com and nothing else',
  connectSrc.length === 1 && connectSrc[0] === 'https://api.github.com',
  `connect-src was "${connectSrc.join(' ')}"`,
)

// ---- the document obeys the policy ----

const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.exec(html)
check(
  'no inline script in the document',
  inlineScript === null,
  `an inline <script> would be blocked by script-src 'self': ${inlineScript?.[0].slice(0, 120)}`,
)

const styleEl = /<style\b/i.exec(html)
check(
  'no inline style element in the document',
  styleEl === null,
  "an inline <style> would be blocked by style-src 'self'",
)

const styleAttr = /<[^>]+\sstyle=["'][^"']*["']/i.exec(html)
check(
  'no inline style attribute in the document',
  styleAttr === null,
  "an inline style attribute would be blocked by style-src 'self'",
)

const externalRefs = [...html.matchAll(/\b(?:src|href)=["'](https?:\/\/[^"']+)["']/gi)].map(
  (m) => m[1],
)
check(
  'every asset is same-origin',
  externalRefs.length === 0,
  `external asset reference would be blocked: ${externalRefs.join(', ')}`,
)

check('referrer policy set', /<meta\s+name=["']referrer["']/i.test(html))

report()

function report() {
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.label}`)
  if (failures.length > 0) {
    console.error(`\n${failures.length} CSP check(s) failed:`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log(`\nAll ${checks.length} CSP checks passed.`)
  process.exit(0)
}
