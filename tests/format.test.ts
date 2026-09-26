import { describe, expect, it } from 'vitest'
import type { DashJob } from '../src/model/queue'
import { oldestWait } from '../src/ui/format'
import { makeJob, makeRun } from './helpers'

const T0 = Date.parse('2026-09-09T10:00:00Z')

function queued(id: number, since: number): DashJob {
  return {
    job: makeJob({ id, run_id: id }),
    run: makeRun({ id }),
    repo: { owner: 'acme', name: 'app' },
    cls: 'macos',
    supersededBy: null,
    since,
  }
}

describe('oldestWait', () => {
  it('reports how long the longest-waiting job has waited', () => {
    const jobs = [queued(1, T0 - 3 * 60_000), queued(2, T0 - 22 * 60_000), queued(3, T0 - 60_000)]

    expect(oldestWait(jobs, T0)).toBe('22m')
  })

  it('ignores jobs with no start time, and answers null when none has one', () => {
    expect(oldestWait([queued(1, 0), queued(2, T0 - 5 * 60_000)], T0)).toBe('5m')
    expect(oldestWait([queued(1, 0)], T0)).toBeNull()
    expect(oldestWait([], T0)).toBeNull()
  })
})
