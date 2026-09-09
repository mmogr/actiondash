#!/usr/bin/env node
/**
 * Enforces that src/github/client.ts is the only module that performs network
 * I/O. The origin guard that keeps the token away from third parties lives
 * there, so a stray fetch, XMLHttpRequest, WebSocket, EventSource or beacon
 * anywhere else would route around it.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const ROOT = 'src'
const ALLOWED = new Set(['src/github/client.ts'])

const PATTERNS = [
  { name: 'fetch(', re: /(?<![\w.$])fetch\s*\(/ },
  { name: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { name: 'WebSocket', re: /\bnew\s+WebSocket\b/ },
  { name: 'EventSource', re: /\bnew\s+EventSource\b/ },
  { name: 'sendBeacon', re: /\bsendBeacon\s*\(/ },
  { name: 'importScripts', re: /\bimportScripts\s*\(/ },
]

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (/\.(ts|tsx)$/.test(entry.name)) yield path
  }
}

const violations = []
let scanned = 0

for await (const path of walk(ROOT)) {
  const rel = relative('.', path).split('\\').join('/')
  if (ALLOWED.has(rel)) continue
  scanned++
  const lines = (await readFile(path, 'utf8')).split('\n')
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) violations.push(`${rel}:${i + 1}  ${name}  ${line.trim()}`)
    }
  })
}

if (violations.length > 0) {
  console.error('Network calls found outside src/github/client.ts:\n')
  for (const v of violations) console.error(`  ${v}`)
  console.error('\nRoute these through apiFetch so the origin guard applies.')
  process.exit(1)
}

console.log(`ok    no direct network calls in ${scanned} modules outside the API client`)
