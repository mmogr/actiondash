import { describe, expect, it } from 'vitest'
import { GitHubError } from '../src/github/client'
import {
  classify,
  dataHealthOf,
  isComplete,
  SNAPSHOT_MAX_AGE_MS,
  snapshotUsable,
  type Problem,
  type RepoProblem,
} from '../src/model/health'

const T0 = Date.parse('2026-09-21T10:00:00Z')

function problems(...kinds: Problem[]): Map<string, RepoProblem> {
  return new Map(
    kinds.map((problem, i) => [`acme/repo${i}`, { problem, detail: '', since: T0, asOf: null }]),
  )
}

describe('classify', () => {
  it('names each way a repository can fail to answer', () => {
    expect(classify(new GitHubError(404, 'Not Found', ''))).toBe('missing')
    expect(classify(new GitHubError(403, 'Resource not accessible', ''))).toBe('denied')
    expect(classify(new GitHubError(502, 'Server Error', ''))).toBe('server')
    expect(classify(new GitHubError(422, 'Unprocessable', ''))).toBe('other')
    expect(classify(new TypeError('Failed to fetch'))).toBe('network')
  })

  it('does not mistake a rate-limit refusal for a permissions problem', () => {
    expect(classify(new GitHubError(403, 'API rate limit exceeded', ''))).toBe('other')
  })
})

describe('snapshotUsable', () => {
  it('stands in for a repository for ten minutes after its last good answer', () => {
    expect(snapshotUsable('server', T0, T0 + SNAPSHOT_MAX_AGE_MS)).toBe(true)
    expect(snapshotUsable('server', T0, T0 + SNAPSHOT_MAX_AGE_MS + 1)).toBe(false)
  })

  it('never stands in for a repository the token cannot see', () => {
    expect(snapshotUsable('missing', T0, T0)).toBe(false)
    expect(snapshotUsable('denied', T0, T0)).toBe(false)
  })
})

describe('dataHealthOf', () => {
  const base = { online: true, limited: false, loaded: true, repoCount: 3, problems: problems() }

  it('is ok only when every repository answered', () => {
    expect(dataHealthOf(base)).toBe('ok')
    expect(dataHealthOf({ ...base, problems: problems('server') })).toBe('partial')
    expect(dataHealthOf({ ...base, problems: problems('server', 'network', 'missing') })).toBe(
      'unreachable',
    )
  })

  it('puts offline first, then the allowance, then the first load', () => {
    expect(dataHealthOf({ ...base, online: false, limited: true, loaded: false })).toBe('offline')
    expect(dataHealthOf({ ...base, limited: true, loaded: false })).toBe('limited')
    expect(dataHealthOf({ ...base, loaded: false })).toBe('none')
  })
})

describe('isComplete', () => {
  it('counts a poll as complete when the only repositories missing never will answer', () => {
    expect(isComplete(3, problems())).toBe(true)
    expect(isComplete(3, problems('missing', 'denied'))).toBe(true)
  })

  it('does not when a repository failed for a reason that may pass, or none answered', () => {
    expect(isComplete(3, problems('server'))).toBe(false)
    expect(isComplete(2, problems('missing', 'missing'))).toBe(false)
  })
})
