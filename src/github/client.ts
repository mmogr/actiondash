/**
 * The single point in the application that performs network I/O.
 *
 * Everything else goes through `apiFetch`. Two properties are enforced here:
 *
 *  1. Origin guard. The bearer token is never attached to a request whose
 *     resolved origin is not https://api.github.com, and such a request is not
 *     issued at all. The Content Security Policy already blocks it at the
 *     browser level; this is the second layer, and the one that also holds
 *     under test and in any non-browser context.
 *  2. Conditional requests. Responses are cached by ETag. GitHub does not
 *     charge a 304 against the hourly rate limit, which is what makes a
 *     15-second poll across a dozen repositories affordable.
 */
import { API_ORIGIN } from '../csp'

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly url: string,
    readonly documentationUrl?: string,
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

/**
 * True when a rejection is GitHub refusing on rate-limit grounds rather than on
 * permissions. Both arrive as 403, and telling a user to check their token
 * scopes when they have simply run out of requests sends them the wrong way.
 */
export function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof GitHubError)) return false
  if (err.status === 429) return true
  if (err.status !== 403) return false
  return /rate limit|abuse detection|secondary rate/i.test(err.message)
}

export class OriginError extends Error {
  constructor(readonly attempted: string) {
    super(
      `Refusing to send credentials to ${attempted}. ` +
        `actiondash only ever talks to ${API_ORIGIN}.`,
    )
    this.name = 'OriginError'
  }
}

/**
 * Resolves a path or absolute URL and rejects anything that is not the GitHub
 * API. Protocol-relative and absolute inputs both resolve before the check, so
 * "//evil.example/x" and "https://evil.example/x" are caught alike.
 */
export function assertGitHubOrigin(pathOrUrl: string): URL {
  let url: URL
  try {
    url = new URL(pathOrUrl, API_ORIGIN)
  } catch {
    throw new OriginError(pathOrUrl)
  }
  if (url.origin !== API_ORIGIN) throw new OriginError(url.origin)
  return url
}

export interface RateLimit {
  limit: number
  remaining: number
  /** Unix seconds. */
  reset: number
}

let rateLimit: RateLimit | null = null
export function getRateLimit(): RateLimit | null {
  return rateLimit
}

/**
 * Requests that actually consumed rate-limit budget. A 304 is excluded because
 * GitHub does not charge conditional requests that return one, which is what
 * lets the poller measure its true cost rather than guess at it.
 */
let billedCount = 0
export function getBilledCount(): number {
  return billedCount
}

/**
 * Milliseconds the API asked us to wait, from retry-after or x-poll-interval.
 *
 * The longest request since the last reset, deliberately, rather than the most
 * recent response's. A poll's requests run concurrently, so which answers last
 * is chance, and a header-less response must not cancel a backoff that
 * another one asked for. The poller resets it as each poll starts, so a
 * request honoured once is not honoured forever.
 */
let retryAfterMs = 0
export function getRetryAfterMs(): number {
  return retryAfterMs
}
export function resetRetryAfter(): void {
  retryAfterMs = 0
}

/** Token access is inverted so that this module never imports application state. */
let tokenProvider: () => string | null = () => null
export function setTokenProvider(fn: () => string | null): void {
  tokenProvider = fn
}

interface CacheEntry {
  etag: string
  body: unknown
}
const etagCache = new Map<string, CacheEntry>()

export function clearCache(): void {
  etagCache.clear()
  rateLimit = null
  billedCount = 0
  retryAfterMs = 0
}

/**
 * Bounds the ETag cache. Job URLs are keyed by run id, so an unbounded map
 * would grow for the life of the session. Insertion order makes the oldest
 * entry the first key.
 */
const MAX_CACHE_ENTRIES = 600
function rememberEtag(key: string, entry: CacheEntry): void {
  if (etagCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = etagCache.keys().next()
    if (!oldest.done) etagCache.delete(oldest.value)
  }
  etagCache.set(key, entry)
}

function captureRateLimit(res: Response): void {
  if (res.status !== 304) billedCount++

  // GitHub asks callers to honour these when it is under load or rate limiting.
  const retryAfter = res.headers.get('retry-after') ?? res.headers.get('x-poll-interval')
  const parsed = retryAfter === null ? NaN : Number(retryAfter)
  if (Number.isFinite(parsed) && parsed > 0) retryAfterMs = Math.max(retryAfterMs, parsed * 1000)

  const remaining = res.headers.get('x-ratelimit-remaining')
  if (remaining === null) return
  rateLimit = {
    limit: Number(res.headers.get('x-ratelimit-limit') ?? 0),
    remaining: Number(remaining),
    reset: Number(res.headers.get('x-ratelimit-reset') ?? 0),
  }
}

export interface ApiResponse<T> {
  data: T
  status: number
  /** Absolute URL of the next page, when the response carried a Link header. */
  nextUrl: string | null
  /** True when the payload was served from the ETag cache. */
  cached: boolean
}

function parseNextLink(header: string | null): string | null {
  if (!header) return null
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (match?.[1]) return match[1]
  }
  return null
}

export interface ApiOptions {
  method?: 'GET' | 'POST'
  /** Disable the ETag cache for this call. */
  noCache?: boolean
  signal?: AbortSignal
}

export async function apiFetch<T>(
  pathOrUrl: string,
  options: ApiOptions = {},
): Promise<ApiResponse<T>> {
  const url = assertGitHubOrigin(pathOrUrl)
  const method = options.method ?? 'GET'
  const key = url.toString()

  const headers = new Headers({
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  })
  const token = tokenProvider()
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const useCache = method === 'GET' && !options.noCache
  const cached = useCache ? etagCache.get(key) : undefined
  if (cached) headers.set('If-None-Match', cached.etag)

  const res = await fetch(key, { method, headers, signal: options.signal })
  captureRateLimit(res)

  const nextUrl = parseNextLink(res.headers.get('link'))

  if (res.status === 304 && cached) {
    return { data: cached.body as T, status: 304, nextUrl, cached: true }
  }

  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    let docs: string | undefined
    try {
      const body = (await res.json()) as { message?: string; documentation_url?: string }
      if (body.message) message = body.message
      docs = body.documentation_url
    } catch {
      // Non-JSON error body; the status line is the best available message.
    }
    throw new GitHubError(res.status, message, key, docs)
  }

  const data = (res.status === 204 ? undefined : await res.json()) as T

  const etag = res.headers.get('etag')
  if (useCache && etag) rememberEtag(key, { etag, body: data })

  return { data, status: res.status, nextUrl, cached: false }
}

/** Follows Link rel="next" and concatenates every page. */
export async function apiFetchAll<T>(
  pathOrUrl: string,
  options: ApiOptions = {},
  maxPages = 10,
): Promise<T[]> {
  const out: T[] = []
  let next: string | null = pathOrUrl
  for (let page = 0; next && page < maxPages; page++) {
    const res: ApiResponse<T[]> = await apiFetch<T[]>(next, options)
    out.push(...res.data)
    next = res.nextUrl
  }
  return out
}
