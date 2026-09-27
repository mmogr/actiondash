import { expect, type BrowserContext, type Page, type Request, type Route, type TestInfo } from '@playwright/test'
import { API, type BrowserGitHub } from './github'
import { NEW_TOKEN, TOKEN } from './seed'

/**
 * What every browser test checks on its way out, whatever it was about. Each
 * finding starts with a tag, and scripts/check-guards.mjs trips each tag on
 * purpose to prove it can fail:
 *
 *   [pageerror]  an uncaught exception, or a crashed page
 *   [console]    anything logged as an error
 *   [csp]        a Content Security Policy violation nobody claimed
 *   [foreign]    a request to anywhere but the page's own server and the API
 *   [asset]      one of the page's own files missing or failing to load
 *   [token]      a test token anywhere but the API's Authorization header
 *   [phantom]    a row for a run the scripted GitHub never reported
 *
 * plus [unscripted], [cors] and [auth] from the scripted GitHub itself.
 */

const SECRETS = [TOKEN, NEW_TOKEN]

const IGNORED_CONSOLE = [
  // Chromium logs every 4xx, 5xx and failed request. Tests script those on
  // purpose; whether one matters is for the network guards to say.
  /^Failed to load resource: /,
  // The policy's own complaint about a violation, which [csp] judges from the
  // violation event instead.
  /Content Security Policy/,
]

export interface Violation {
  directive: string
  blockedURI: string
  sample: string
}

/** Replaces any test token in text, so a failure message never repeats one. */
function redact(text: string): string {
  return SECRETS.reduce((out, secret) => out.split(secret).join('<token>'), text)
}

function leaks(text: string | null | undefined): boolean {
  return typeof text === 'string' && SECRETS.some((secret) => text.includes(secret))
}

export class Guards {
  private readonly problems: string[] = []
  private readonly violations: Violation[] = []
  private readonly claimed = new Set<Violation>()
  private readonly requests: Request[] = []
  private readonly consoleText: string[] = []

  constructor(
    private readonly origin: string,
    private readonly github: BrowserGitHub,
  ) {}

  async attach(context: BrowserContext, page: Page): Promise<void> {
    this.watch(page)
    context.on('page', (opened) => this.watch(opened))
    context.on('request', (request) => this.requests.push(request))
    context.on('response', (response) => {
      if (this.isOwn(response.url()) && response.status() >= 400) {
        this.problems.push(`[asset] ${response.status()} for ${new URL(response.url()).pathname}`)
      }
    })
    context.on('requestfailed', (request) => {
      const failure = request.failure()?.errorText ?? 'failed'
      // An aborted request is one the page stopped needing, as on a reload.
      if (this.isOwn(request.url()) && failure !== 'net::ERR_ABORTED') {
        this.problems.push(`[asset] ${failure} for ${new URL(request.url()).pathname}`)
      }
    })

    // Reported through a binding, which the policy does not govern and which
    // survives reloads, so a violation on any page load is seen.
    await context.exposeBinding('__e2eCspViolation', (_source, violation: Violation) => {
      this.violations.push(violation)
    })
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        const report = (window as unknown as { __e2eCspViolation(v: Violation): void }).__e2eCspViolation
        report({ directive: event.effectiveDirective, blockedURI: event.blockedURI, sample: event.sample })
      })
    })

    // The policy should stop these before they leave the page. This catches
    // any that get past it, and keeps them from reaching the internet.
    await context.route(
      (url) => /^(https?|wss?):$/.test(url.protocol) && url.origin !== this.origin && url.origin !== API,
      (route) => this.foreign(route),
    )
  }

  /**
   * Claims one violation the test caused on purpose, waiting for it to be
   * reported. Anything unclaimed fails the test.
   */
  async expectCspViolation(expected: { directive: string; blockedURI: string }): Promise<void> {
    const find = () =>
      this.violations.find(
        (v) =>
          !this.claimed.has(v) &&
          v.directive === expected.directive &&
          v.blockedURI.startsWith(expected.blockedURI),
      )
    await expect
      .poll(() => find() !== undefined, {
        message: `expected a ${expected.directive} violation for ${expected.blockedURI}`,
      })
      .toBe(true)
    const found = find()
    if (found) this.claimed.add(found)
  }

  async verify(context: BrowserContext, testInfo: TestInfo): Promise<void> {
    // Events cross from the browser asynchronously. A round trip to each page
    // lets anything it has already done report in first.
    for (const page of context.pages()) await page.evaluate(() => 0).catch(() => {})

    const problems = [...this.problems, ...this.github.problems]
    for (const v of this.violations) {
      if (!this.claimed.has(v)) {
        problems.push(`[csp] ${v.directive} refused ${v.blockedURI}${v.sample ? `: ${v.sample}` : ''}`)
      }
    }
    problems.push(...(await this.findLeaks(context)))
    problems.push(...(await this.findPhantoms(context)))

    const report = problems.map(redact)
    if (report.length > 0) {
      await testInfo.attach('guards.json', {
        body: JSON.stringify({ problems: report, calls: this.github.calls.map((c) => `${c.method} ${c.path}`) }, null, 2),
        contentType: 'application/json',
      })
    }
    expect(report, 'browser guards').toEqual([])
  }

  private watch(page: Page): void {
    page.on('pageerror', (error) => this.problems.push(`[pageerror] ${error.message}`))
    page.on('crash', () => this.problems.push('[pageerror] the page crashed'))
    page.on('websocket', (socket) => this.problems.push(`[foreign] a websocket to ${socket.url()}`))
    page.on('console', (message) => {
      this.consoleText.push(message.text())
      if (message.type() === 'error' && !IGNORED_CONSOLE.some((re) => re.test(message.text()))) {
        this.problems.push(`[console] ${message.text()}`)
      }
    })
  }

  private isOwn(url: string): boolean {
    return new URL(url).origin === this.origin
  }

  private async foreign(route: Route): Promise<void> {
    const request = route.request()
    const url = new URL(request.url())
    // The page links to runs and logs on github.com. Following one is fine;
    // the test just does not leave for it.
    if (!(request.isNavigationRequest() && url.origin === 'https://github.com')) {
      this.problems.push(`[foreign] ${request.method()} ${url.origin}${url.pathname}`)
    }
    await route.abort('blockedbyclient').catch(() => {})
  }

  private async findLeaks(context: BrowserContext): Promise<string[]> {
    const found = new Set<string>()
    for (const request of this.requests) {
      const where = redact(request.url())
      if (leaks(request.url())) found.add(`[token] in the address ${where}`)
      if (leaks(request.postData())) found.add(`[token] in the body sent to ${where}`)
      const headers = await request.allHeaders().catch(() => ({}) as Record<string, string>)
      for (const [name, value] of Object.entries(headers)) {
        const expected = name === 'authorization' && new URL(request.url()).origin === API
        if (!expected && leaks(value)) found.add(`[token] in the ${name} header sent to ${where}`)
      }
    }
    if (this.consoleText.some(leaks)) found.add('[token] in the console')
    for (const page of context.pages()) {
      const state = await page
        .evaluate(() => ({ html: document.documentElement.outerHTML, title: document.title, href: location.href }))
        .catch(() => null)
      if (leaks(state?.html)) found.add('[token] in the page')
      if (leaks(state?.title)) found.add('[token] in the title')
      if (leaks(state?.href)) found.add('[token] in the address bar')
    }
    if (leaks(JSON.stringify(await context.cookies()))) found.add('[token] in a cookie')
    return [...found]
  }

  /** The browser form of the conservation check in tests/poll.test.ts. */
  private async findPhantoms(context: BrowserContext): Promise<string[]> {
    const found: string[] = []
    for (const page of context.pages()) {
      const ids = await page
        .$$eval('[data-run]', (rows) => rows.map((row) => row.getAttribute('data-run')))
        .catch(() => [] as (string | null)[])
      for (const id of new Set(ids)) {
        if (!this.github.served.has(Number(id))) found.push(`[phantom] a row for run ${id}, which GitHub never reported`)
      }
    }
    return found
  }
}
