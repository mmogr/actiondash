import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  apiFetch,
  assertGitHubOrigin,
  clearCache,
  getRateLimit,
  GitHubError,
  OriginError,
  setTokenProvider,
} from '../src/github/client'

function respond(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(init.status === 304 ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

function callArgs(mock: { mock: { calls: unknown[] } }, index: number): [string, RequestInit] {
  return mock.mock.calls[index] as unknown as [string, RequestInit]
}

describe('assertGitHubOrigin', () => {
  it('accepts a relative API path', () => {
    expect(assertGitHubOrigin('/user').toString()).toBe('https://api.github.com/user')
  })

  it('accepts an absolute GitHub API URL, as used for pagination', () => {
    const url = 'https://api.github.com/user/repos?page=2'
    expect(assertGitHubOrigin(url).toString()).toBe(url)
  })

  it('rejects any other host', () => {
    expect(() => assertGitHubOrigin('https://evil.example/steal')).toThrow(OriginError)
  })

  it('rejects a protocol-relative URL', () => {
    expect(() => assertGitHubOrigin('//evil.example/steal')).toThrow(OriginError)
  })

  it('rejects a look-alike host and a non-API GitHub host', () => {
    expect(() => assertGitHubOrigin('https://api.github.com.evil.example/x')).toThrow(OriginError)
    expect(() => assertGitHubOrigin('https://github.com/x')).toThrow(OriginError)
  })

  it('rejects a plaintext scheme on the right host', () => {
    expect(() => assertGitHubOrigin('http://api.github.com/user')).toThrow(OriginError)
  })
})

describe('apiFetch', () => {
  beforeEach(() => {
    clearCache()
    setTokenProvider(() => 'github_pat_secret')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setTokenProvider(() => null)
    clearCache()
  })

  it('never issues a request to a non-GitHub origin', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiFetch('https://evil.example/steal')).rejects.toThrow(OriginError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('attaches the bearer token and the API version header', async () => {
    const fetchMock = vi.fn(async () => respond({ login: 'octocat' }))
    vi.stubGlobal('fetch', fetchMock)

    await apiFetch('/user')

    const [url, init] = callArgs(fetchMock, 0)
    expect(url).toBe('https://api.github.com/user')
    const headers = init.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer github_pat_secret')
    expect(headers.get('X-GitHub-Api-Version')).toBe('2022-11-28')
    expect(headers.get('Accept')).toBe('application/vnd.github+json')
  })

  it('omits the Authorization header when there is no token', async () => {
    setTokenProvider(() => null)
    const fetchMock = vi.fn(async () => respond({}))
    vi.stubGlobal('fetch', fetchMock)

    await apiFetch('/user')

    const [, init] = callArgs(fetchMock, 0)
    expect((init.headers as Headers).has('Authorization')).toBe(false)
  })

  it('replays the cached body on a 304 and sends If-None-Match', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond({ value: 1 }, { headers: { etag: 'W/"abc"' } }))
      .mockResolvedValueOnce(respond(null, { status: 304, headers: { etag: 'W/"abc"' } }))
    vi.stubGlobal('fetch', fetchMock)

    const first = await apiFetch<{ value: number }>('/thing')
    const second = await apiFetch<{ value: number }>('/thing')

    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
    expect(second.status).toBe(304)
    expect(second.data).toEqual({ value: 1 })

    const [, secondInit] = callArgs(fetchMock, 1)
    expect((secondInit.headers as Headers).get('If-None-Match')).toBe('W/"abc"')
  })

  it('does not use the cache when noCache is set', async () => {
    const fetchMock = vi.fn(async () => respond({ v: 1 }, { headers: { etag: 'W/"abc"' } }))
    vi.stubGlobal('fetch', fetchMock)

    await apiFetch('/thing')
    await apiFetch('/thing', { noCache: true })

    const [, second] = callArgs(fetchMock, 1)
    expect((second.headers as Headers).has('If-None-Match')).toBe(false)
  })

  it('records the rate limit from the response headers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        respond(
          {},
          {
            headers: {
              'x-ratelimit-limit': '5000',
              'x-ratelimit-remaining': '4993',
              'x-ratelimit-reset': '1789000000',
            },
          },
        ),
      ),
    )

    await apiFetch('/user')

    expect(getRateLimit()).toEqual({ limit: 5000, remaining: 4993, reset: 1789000000 })
  })

  it('raises a GitHubError carrying the status and the API message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond({ message: 'Resource not accessible by personal access token' }, { status: 403 })),
    )

    await expect(apiFetch('/repos/acme/app/actions/runs')).rejects.toMatchObject({
      name: 'GitHubError',
      status: 403,
      message: 'Resource not accessible by personal access token',
    })
  })

  it('falls back to the status line when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('gateway blew up', { status: 502, statusText: 'Bad Gateway' })),
    )

    const error = await apiFetch('/user').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GitHubError)
    expect((error as GitHubError).status).toBe(502)
  })

  it('accepts a write answered with no body, as a re-run is', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 201 })))

    const res = await apiFetch('/repos/acme/app/actions/runs/1/rerun', { method: 'POST', noCache: true })

    expect(res.status).toBe(201)
    expect(res.data).toBeUndefined()
  })

  it('still reads a write answered with a body, as a cancel is', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({}, { status: 202 })))

    const res = await apiFetch('/repos/acme/app/actions/runs/1/cancel', { method: 'POST', noCache: true })

    expect(res.data).toEqual({})
  })

  it('reads 204 as no content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))

    expect((await apiFetch('/anything', { method: 'POST', noCache: true })).data).toBeUndefined()
  })
})
