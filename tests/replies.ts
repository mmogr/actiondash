/**
 * Scripted GitHub replies, shared by the unit tests' fake and the browser
 * tests' fake. Nothing here imports a test runner, so either can load it.
 *
 * Replies are only ever what the test says GitHub returned; they know nothing
 * about GitHub itself, which is the point.
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

export function abortError(): DOMException {
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
