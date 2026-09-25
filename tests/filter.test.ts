import { describe, expect, it } from 'vitest'
import { groupByRun } from '../src/model/queue'
import { matchesFilter, NO_FILTER } from '../src/model/filter'
import type { DashJob } from '../src/model/queue'
import { makeJob, makeRun } from './helpers'

function entry(over: Partial<DashJob> = {}): DashJob {
  const run = over.run ?? makeRun({ id: 1 })
  return {
    job: makeJob({ id: 10, run_id: run.id }),
    run,
    repo: { owner: run.repoOwner, name: run.repoName },
    cls: 'macos',
    supersededBy: null,
    since: 1,
    ...over,
  }
}

describe('matchesFilter', () => {
  it('shows everything under the empty filter', () => {
    const [group] = groupByRun([entry()])

    expect(matchesFilter(group!, NO_FILTER)).toBe(true)
  })

  it('narrows to one repository without regard to case', () => {
    // The watch list is not case-normalised, so the chip must not be either.
    const [group] = groupByRun([entry()])

    expect(matchesFilter(group!, { repo: 'Acme/App', staleOnly: false })).toBe(true)
    expect(matchesFilter(group!, { repo: 'acme/other', staleOnly: false })).toBe(false)
  })

  it('keeps only superseded runs when asked', () => {
    const newer = makeRun({ id: 2 })
    const [fresh] = groupByRun([entry()])
    const [stale] = groupByRun([entry({ supersededBy: newer })])

    expect(matchesFilter(fresh!, { repo: null, staleOnly: true })).toBe(false)
    expect(matchesFilter(stale!, { repo: null, staleOnly: true })).toBe(true)
  })
})
