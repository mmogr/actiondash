import { vi } from 'vitest'
import { abortError, type Call, type Reply } from './replies'

export { deferred, empty, json, type Call, type Deferred, type Reply } from './replies'

/**
 * A scripted stand-in for api.github.com, installed as the global fetch.
 *
 * Every request has to match a route the test declared, and an unmatched one
 * throws, so a test can never pass by reaching an endpoint nobody scripted.
 * The replies live in ./replies, where the browser tests' fake can share them.
 */

export class FakeGitHub {
  readonly calls: Call[] = []
  private readonly routes = new Map<string, { re: RegExp; reply: Reply }>()

  /** Declares, or replaces, the reply for every URL the pattern matches. */
  on(re: RegExp, reply: Reply): this {
    this.routes.set(re.source, { re, reply })
    return this
  }

  install(): this {
    vi.stubGlobal('fetch', this.fetch)
    return this
  }

  readonly fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const call: Call = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: init.body,
      signal: init.signal ?? undefined,
    }
    this.calls.push(call)
    if (call.signal?.aborted) throw abortError()
    for (const { re, reply } of this.routes.values()) {
      if (re.test(call.url)) return reply(call)
    }
    throw new Error(`Unscripted request: ${call.method} ${call.url}`)
  }
}
