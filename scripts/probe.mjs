#!/usr/bin/env node
/**
 * Reads what GitHub actually does with the queries this dashboard sends, and
 * prints it. It asserts nothing: the output is evidence to read, not a verdict.
 *
 * The tests can only check the app against what its author believes GitHub
 * returns. This checks the beliefs. It imports the query strings from
 * src/github/queries.ts, so it asks about the contract the app really uses.
 *
 * It runs by hand, never on a schedule. Its readings depend on a quiet token:
 * an earlier measurement concluded that GitHub bills conditional requests,
 * and a clean rerun showed that was other traffic on a shared token. A
 * scheduled workflow on a public repository is also disabled silently after
 * sixty days without activity.
 *
 * Usage:  npm run probe -- [owner/repo ...]
 * Token:  GITHUB_TOKEN, or else `gh auth token`. Use one nothing else is using.
 */
import { execFileSync } from 'node:child_process'
import { JOBS_QUERY, RUN_STATUSES, runsQuery } from '../src/github/queries.ts'

const API = 'https://api.github.com'
const DEFAULT_REPOS = [
  'nodejs/node',
  'elastic/kibana',
  'home-assistant/core',
  'rust-lang/rust',
  'microsoft/vscode',
]
const CONDITIONAL_REPEATS = 20

const repos = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_REPOS
const token =
  process.env.GITHUB_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()

async function get(path, headers = {}) {
  const res = await fetch(API + path, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
      ...headers,
    },
  })
  const body = res.status === 304 ? null : await res.json().catch(() => null)
  return { res, body }
}

const remaining = (res) => Number(res.headers.get('x-ratelimit-remaining'))

console.log(`probe  ${new Date().toISOString()}  (listings are capped at 100 runs)\n`)

console.log('Status filter: is a run returned by both listings, and does its status match?')
let sampleRun = null
for (const repo of repos) {
  const lists = {}
  for (const status of RUN_STATUSES) {
    const { res, body } = await get(`/repos/${repo}/actions/runs${runsQuery(status)}`)
    if (!res.ok) console.log(`  ${repo}  ${status}: HTTP ${res.status}`)
    lists[status] = body?.workflow_runs ?? []
  }
  const [first, second] = RUN_STATUSES.map((s) => new Set(lists[s].map((r) => r.id)))
  const inBoth = [...first].filter((id) => second.has(id)).length
  const mismatched = RUN_STATUSES.flatMap((s) => lists[s].filter((r) => r.status !== s)).length
  const counts = RUN_STATUSES.map((s) => `${s} ${lists[s].length}`).join('  ')
  console.log(`  ${repo.padEnd(22)} ${counts}  in both ${inBoth}  status differs ${mismatched}`)
  sampleRun ??= lists.in_progress[0] ? { repo, id: lists.in_progress[0].id } : null
}

console.log('\nJob statuses seen in one in-progress run:')
if (sampleRun) {
  const { res, body } = await get(
    `/repos/${sampleRun.repo}/actions/runs/${sampleRun.id}/jobs${JOBS_QUERY}`,
  )
  const tally = {}
  for (const job of body?.jobs ?? []) tally[job.status] = (tally[job.status] ?? 0) + 1
  console.log(`  ${sampleRun.repo} run ${sampleRun.id}: HTTP ${res.status}  ${JSON.stringify(tally)}`)
} else {
  console.log('  no in-progress run found')
}

console.log('\nAn unrecognised status value:')
{
  const { res, body } = await get(`/repos/${repos[0]}/actions/runs${runsQuery('bogus_value')}`)
  console.log(`  ${repos[0]}  status=bogus_value: HTTP ${res.status}  total_count ${body?.total_count}`)
}

console.log(`\nConditional requests: ${CONDITIONAL_REPEATS} repeats with If-None-Match:`)
{
  const path = `/repos/${repos[0]}/actions/runs${runsQuery(RUN_STATUSES[0])}`
  const { res: primed } = await get(path)
  const etag = primed.headers.get('etag')
  const before = remaining(primed)
  const statuses = {}
  let last = primed
  for (let i = 0; i < CONDITIONAL_REPEATS; i++) {
    const { res } = await get(path, etag ? { 'If-None-Match': etag } : {})
    statuses[res.status] = (statuses[res.status] ?? 0) + 1
    last = res
  }
  console.log(`  responses ${JSON.stringify(statuses)}`)
  console.log(`  x-ratelimit-remaining ${before} -> ${remaining(last)} (moved ${before - remaining(last)})`)
  console.log('  Anything else using this token in the meantime also moves this figure.')
}

// Beliefs the job graphs rest on (src/model/workflow.ts, README "Job graphs").

/** The most recent completed runs of the first repository that has some. */
async function recentCompleted(count) {
  for (const repo of repos) {
    const { body } = await get(`/repos/${repo}/actions/runs?status=completed&per_page=${count}`)
    const runs = (body?.workflow_runs ?? []).filter((r) => r.conclusion !== 'skipped' && r.path && !r.path.startsWith('dynamic/'))
    if (runs.length) return { repo, runs }
  }
  return { repo: repos[0], runs: [] }
}

console.log('\nA job that waited is created when the last job before it ends:')
{
  const { repo, runs } = await recentCompleted(10)
  let waited = 0
  let onTime = 0
  for (const run of runs) {
    const { body } = await get(`/repos/${repo}/actions/runs/${run.id}/jobs${JOBS_QUERY}`)
    const jobs = body?.jobs ?? []
    const start = Math.min(...jobs.map((j) => Date.parse(j.created_at)))
    const ends = jobs.filter((j) => j.completed_at && j.conclusion !== 'skipped').map((j) => Date.parse(j.completed_at))
    for (const job of jobs) {
      if (['skipped', 'cancelled'].includes(job.conclusion)) continue
      const created = Date.parse(job.created_at)
      if (created - start < 5_000) continue
      waited++
      if (ends.some((end) => Math.abs(created - end) <= 2_000)) onTime++
    }
  }
  console.log(`  ${repo}: ${onTime} of ${waited} jobs created after their run began were created within 2s of another job's end`)
  console.log('  Read without the workflow file, so a coincidence can pass; anything short of all of them is worth a look.')
}

console.log('\nWhat job listings hold besides jobs:')
{
  const { repo, runs } = await recentCompleted(20)
  let checkRuns = 0
  let rawNames = 0
  let total = 0
  for (const run of runs) {
    const { body } = await get(`/repos/${repo}/actions/runs/${run.id}/jobs${JOBS_QUERY}`)
    for (const job of body?.jobs ?? []) {
      total++
      if (!/\/actions\/runs\/\d+\/job\/\d+/.test(job.html_url)) checkRuns++
      if (job.name.includes('${{')) rawNames++
    }
  }
  console.log(`  ${repo}: ${total} entries, ${checkRuns} check runs that are not jobs, ${rawNames} listed under an unevaluated \${{ }} name`)
}

console.log('\nA workflow file\'s ETag at a later commit that left it alone:')
{
  const { repo, runs } = await recentCompleted(30)
  const byPath = new Map()
  for (const run of runs) byPath.set(run.path, [...(byPath.get(run.path) ?? []), run.head_sha])
  const pair = [...byPath].find(([, shas]) => new Set(shas).size > 1)
  if (!pair) {
    console.log(`  ${repo}: no workflow ran at two commits recently`)
  } else {
    const [path, shas] = pair
    const [later, earlier] = [...new Set(shas)]
    const raw = { Accept: 'application/vnd.github.raw+json' }
    const first = await get(`/repos/${repo}/contents/${path}?ref=${earlier}`, raw)
    const etag = first.res.headers.get('etag')
    const second = await get(`/repos/${repo}/contents/${path}?ref=${later}`, { ...raw, 'If-None-Match': etag ?? '' })
    console.log(`  ${repo} ${path}: HTTP ${first.res.status} then ${second.res.status} with the first ETag`)
    console.log(`  x-ratelimit-remaining ${remaining(first.res)} -> ${remaining(second.res)}`)
    console.log('  304 means the file did not change between the commits and the second read was free.')
  }
}

console.log('\nGitHub\'s job times against its own clock:')
{
  const { res, body } = await get(`/repos/${repos[0]}/actions/runs?per_page=20`)
  const serverNow = Date.parse(res.headers.get('date') ?? '')
  const ahead = (body?.workflow_runs ?? []).map((r) => Date.parse(r.created_at) - serverNow).filter((d) => d > 60_000)
  console.log(
    ahead.length
      ? `  ${repos[0]}: ${ahead.length} runs created up to ${Math.round(Math.max(...ahead) / 60_000)}m after the response's Date header`
      : `  ${repos[0]}: no run created after the response's Date header`,
  )
  console.log('  On 2026-11-01 runs read 30 minutes ahead; elapsed times shown against the browser clock were wrong then.')
}
