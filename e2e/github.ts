import type { BrowserContext, Request, Route } from '@playwright/test'
import { JOBS_QUERY, runsQuery } from '../src/github/queries'
import type { RepoRef, WorkflowJob, WorkflowRun } from '../src/github/types'
import { json, type Call, type Reply } from '../tests/replies'
import { NEW_TOKEN, TOKEN } from './seed'

/**
 * A scripted api.github.com for the browser, the counterpart of
 * tests/fake-github.ts. Every request the page makes to the API lands here.
 * One nobody scripted is answered 501 and fails the test, so a test can never
 * pass by reaching an endpoint it did not describe, or by reaching GitHub.
 *
 * Chromium enforces the response half of CORS on routed replies (a header
 * GitHub does not expose stays unreadable to the page) but not the request
 * half: a preflight never happens. So the replies carry GitHub's real exposed
 * headers, and the request half is checked here, against what GitHub's real
 * preflight allows. Without that, a new request header would pass every test
 * and fail in every browser.
 */

export const API = 'https://api.github.com'

// Recorded from api.github.com on 2026-09-27 with
//   curl -si https://api.github.com/zen -H 'Origin: http://127.0.0.1'
// and the matching OPTIONS preflight. Refresh them the same way.
const EXPOSE_HEADERS =
  'ETag, Link, Location, Retry-After, X-GitHub-OTP, X-RateLimit-Limit, X-RateLimit-Remaining, ' +
  'X-RateLimit-Used, X-RateLimit-Resource, X-RateLimit-Reset, X-OAuth-Scopes, X-Accepted-OAuth-Scopes, ' +
  'X-Poll-Interval, X-GitHub-Media-Type, X-GitHub-SSO, X-GitHub-Request-Id, Deprecation, Sunset, Warning'
const ALLOW_HEADERS = new Set(
  (
    'Authorization, Content-Type, If-Match, If-Modified-Since, If-None-Match, If-Unmodified-Since, ' +
    'Accept-Encoding, X-GitHub-OTP, X-Requested-With, User-Agent, GraphQL-Features, ' +
    'X-Github-Next-Global-ID, X-GitHub-Api-Version, X-Fetch-Nonce, Copilot-Integration-Id, ' +
    'DD-CLIENT-TOKEN, X-Client-Application'
  )
    .toLowerCase()
    .split(', '),
)
const ALLOW_METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])

/** Headers the browser sets itself, or that never need a preflight. */
const NO_PREFLIGHT = /^(accept|accept-language|content-language|origin|referer|user-agent|sec-.+)$/

const BEARERS = new Set([`Bearer ${TOKEN}`, `Bearer ${NEW_TOKEN}`])

export interface ApiCall {
  method: string
  url: string
  /** The path and query, for readable failure messages. */
  path: string
  headers: Record<string, string>
  body: string | null
}

/** Escapes a string for use inside a RegExp. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function repoPath(repo: RepoRef): string {
  return `/repos/${literal(repo.owner)}/${literal(repo.name)}`
}

export class BrowserGitHub {
  readonly calls: ApiCall[] = []
  /** Everything that must fail the test, each line starting with its tag. */
  readonly problems: string[] = []
  /** Every run id this fake has told the page about. */
  readonly served = new Set<number>()

  private readonly routes = new Map<string, { re: RegExp; reply: Reply }>()
  private remaining = 5000

  /** resetAt is when the hourly allowance renews, in epoch seconds. */
  constructor(private readonly resetAt: number) {}

  /** Declares, or replaces, the reply for every URL the pattern matches. */
  on(re: RegExp, reply: Reply): this {
    this.routes.set(re.source, { re, reply })
    return this
  }

  user(login = 'octocat'): this {
    return this.on(/\/user$/, json({ login, name: null }))
  }

  /** Both run listings of one repository. */
  runs(repo: RepoRef, queued: WorkflowRun[], running: WorkflowRun[]): this {
    for (const run of [...queued, ...running]) this.served.add(run.id)
    this.on(this.runsPattern(repo, 'queued'), json({ total_count: queued.length, workflow_runs: queued }))
    return this.on(
      this.runsPattern(repo, 'in_progress'),
      json({ total_count: running.length, workflow_runs: running }),
    )
  }

  jobs(runId: number, jobs: WorkflowJob[]): this {
    return this.on(
      new RegExp(`/actions/runs/${runId}/jobs${literal(JOBS_QUERY)}$`),
      json({ total_count: jobs.length, jobs }),
    )
  }

  async attach(context: BrowserContext): Promise<void> {
    await context.route(`${API}/**`, (route) => this.handle(route))
  }

  private runsPattern(repo: RepoRef, status: string): RegExp {
    return new RegExp(`${repoPath(repo)}/actions/runs${literal(runsQuery(status))}$`)
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request()
    // Never reached in Chromium today, which answers preflights for routed
    // requests itself. Answered anyway, so a browser that does ask is not
    // mistaken for an unscripted request.
    if (request.method() === 'OPTIONS') {
      return settle(route.fulfill({ status: 204, headers: corsHeaders() }))
    }

    const call = await this.record(request)
    const scripted = [...this.routes.values()].find((r) => r.re.test(call.url))
    if (!scripted) {
      this.problems.push(`[unscripted] ${call.method} ${call.path}`)
      return settle(
        route.fulfill({
          status: 501,
          headers: { ...corsHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({ message: `Unscripted request: ${call.method} ${call.path}` }),
        }),
      )
    }

    let response: Response
    try {
      response = await scripted.reply(toReplyCall(call))
    } catch {
      // A reply that throws is a network failure, as fetch reports one.
      return settle(route.abort('failed'))
    }

    const headers: Record<string, string> = { ...corsHeaders() }
    Object.assign(headers, this.rateHeaders(response.status))
    response.headers.forEach((value, name) => {
      headers[name] = value
    })
    const body = Buffer.from(await response.arrayBuffer())
    return settle(route.fulfill({ status: response.status, headers, body }))
  }

  private async record(request: Request): Promise<ApiCall> {
    const headers = await request.allHeaders()
    const url = new URL(request.url())
    const call: ApiCall = {
      method: request.method(),
      url: request.url(),
      path: url.pathname + url.search,
      headers,
      body: request.postData(),
    }
    this.calls.push(call)

    if (!ALLOW_METHODS.has(call.method)) {
      this.problems.push(`[cors] GitHub does not allow ${call.method}: ${call.path}`)
    }
    for (const name of Object.keys(headers)) {
      if (!NO_PREFLIGHT.test(name) && !ALLOW_HEADERS.has(name)) {
        this.problems.push(`[cors] GitHub's preflight would refuse the header ${name}: ${call.path}`)
      }
    }
    if (!BEARERS.has(headers.authorization ?? '')) {
      this.problems.push(`[auth] no test token in Authorization: ${call.method} ${call.path}`)
    }
    return call
  }

  /** GitHub's rate-limit headers, counting down on every reply that costs a request. A reply's own headers win. */
  private rateHeaders(status: number): Record<string, string> {
    if (status !== 304) this.remaining = Math.max(0, this.remaining - 1)
    return {
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': String(this.remaining),
      'x-ratelimit-used': String(5000 - this.remaining),
      'x-ratelimit-resource': 'core',
      'x-ratelimit-reset': String(this.resetAt),
    }
  }
}

function corsHeaders(): Record<string, string> {
  return { 'access-control-allow-origin': '*', 'access-control-expose-headers': EXPOSE_HEADERS }
}

function toReplyCall(call: ApiCall): Call {
  return {
    url: call.url,
    method: call.method,
    headers: new Headers(call.headers),
    body: call.body,
    signal: undefined,
  }
}

/**
 * A reply can still be pending when its test ends and the page closes, and
 * answering a closed page throws. That says nothing about the test.
 */
async function settle(answer: Promise<void>): Promise<void> {
  await answer.catch(() => {})
}
