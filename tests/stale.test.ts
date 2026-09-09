import { describe, expect, it } from 'vitest'
import { findSupersededRuns } from '../src/model/stale'
import { makeRun } from './helpers'

const OLD = '2026-09-09T10:00:00Z'
const NEW = '2026-09-09T10:05:00Z'

describe('findSupersededRuns', () => {
  it('marks an older run on a different commit as superseded', () => {
    const older = makeRun({ id: 1, run_number: 1, created_at: OLD, head_sha: 'aaa' })
    const newer = makeRun({ id: 2, run_number: 2, created_at: NEW, head_sha: 'bbb' })

    const result = findSupersededRuns([older, newer])

    expect(result.get(1)?.id).toBe(2)
    expect(result.has(2)).toBe(false)
  })

  it('does not mark a re-run of the same commit', () => {
    const first = makeRun({ id: 1, run_number: 1, created_at: OLD, head_sha: 'aaa' })
    const rerun = makeRun({ id: 2, run_number: 2, created_at: NEW, head_sha: 'aaa' })

    expect(findSupersededRuns([first, rerun]).size).toBe(0)
  })

  it('does not compare across different workflows', () => {
    const build = makeRun({ id: 1, workflow_id: 100, created_at: OLD, head_sha: 'aaa' })
    const lint = makeRun({ id: 2, workflow_id: 200, created_at: NEW, head_sha: 'bbb' })

    expect(findSupersededRuns([build, lint]).size).toBe(0)
  })

  it('does not compare across different branches', () => {
    const main = makeRun({ id: 1, head_branch: 'main', created_at: OLD, head_sha: 'aaa' })
    const feat = makeRun({ id: 2, head_branch: 'feat', created_at: NEW, head_sha: 'bbb' })

    expect(findSupersededRuns([main, feat]).size).toBe(0)
  })

  it('does not compare across different repositories', () => {
    const a = makeRun({ id: 1, repoName: 'app', created_at: OLD, head_sha: 'aaa' })
    const b = makeRun({ id: 2, repoName: 'site', created_at: NEW, head_sha: 'bbb' })

    expect(findSupersededRuns([a, b]).size).toBe(0)
  })

  it('reports the newest run when several supersede one', () => {
    const oldest = makeRun({ id: 1, run_number: 1, created_at: OLD, head_sha: 'aaa' })
    const middle = makeRun({ id: 2, run_number: 2, created_at: NEW, head_sha: 'bbb' })
    const newest = makeRun({ id: 3, run_number: 3, created_at: '2026-09-09T10:09:00Z', head_sha: 'ccc' })

    const result = findSupersededRuns([oldest, middle, newest])

    expect(result.get(1)?.id).toBe(3)
    expect(result.get(2)?.id).toBe(3)
    expect(result.has(3)).toBe(false)
  })

  it('breaks identical timestamps with the run number', () => {
    const older = makeRun({ id: 1, run_number: 7, created_at: OLD, head_sha: 'aaa' })
    const newer = makeRun({ id: 2, run_number: 8, created_at: OLD, head_sha: 'bbb' })

    expect(findSupersededRuns([older, newer]).get(1)?.id).toBe(2)
  })

  it('ignores runs with no branch', () => {
    const a = makeRun({ id: 1, head_branch: null, created_at: OLD, head_sha: 'aaa' })
    const b = makeRun({ id: 2, head_branch: null, created_at: NEW, head_sha: 'bbb' })

    expect(findSupersededRuns([a, b]).size).toBe(0)
  })

  it('returns nothing for a single run', () => {
    expect(findSupersededRuns([makeRun()]).size).toBe(0)
  })
})
