import { vi } from 'vitest'

/**
 * A scripted stand-in for api.github.com, installed as the global fetch.
 *
 * Every request has to match a route the test declared, and an unmatched one
 * throws, so a test can never pass by reaching an endpoint nobody scripted.
 * Replies are only ever what the test says GitHub returned; the fake knows
 * nothing about GitHub itself, which is the point.
 */

export interface Call {
  url: string
  method: string
  headers: Headers
  body: unknown
  signal: AbortSignal | undefined
}

export type Reply = (call: Call) => Response | Promise<Response>

export function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Reply {
  return () =>
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json', ...init.headers },
    })
}

/** A response with no body at all, as GitHub gives for some writes. */
export function empty(status = 201): Reply {
  return () => new Response(null, { status })
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

export interface Deferred {
  reply: Reply
  resolve(reply: Reply): void
}

/**
 * A reply that stays pending until the test resolves it, for driving an
 * interleaving step by step rather than by timing.
 *
 * With honourAbort it rejects when the request's signal aborts, as a real fetch
 * does. Without it, it models a response already on its way back, which is
 * what a request the caller never told about the abort looks like.
 */
export function deferred(options: { honourAbort?: boolean } = {}): Deferred {
  let settle: ((reply: Reply) => void) | null = null
  const pending = new Promise<Reply>((resolve) => {
    settle = resolve
  })
  return {
    reply: (call) =>
      new Promise<Response>((resolve, reject) => {
        if (options.honourAbort && call.signal) {
          if (call.signal.aborted) return reject(abortError())
          call.signal.addEventListener('abort', () => reject(abortError()), { once: true })
        }
        void pending.then(async (reply) => resolve(await reply(call)))
      }),
    resolve: (reply) => settle?.(reply),
  }
}

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
