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

    expect(matchesFilter(group!, { ...NO_FILTER, repo: 'Acme/App' })).toBe(true)
    expect(matchesFilter(group!, { ...NO_FILTER, repo: 'acme/other' })).toBe(false)
  })

  it('keeps only superseded runs when asked', () => {
    const newer = makeRun({ id: 2 })
    const [fresh] = groupByRun([entry()])
    const [stale] = groupByRun([entry({ supersededBy: newer })])

    expect(matchesFilter(fresh!, { ...NO_FILTER, staleOnly: true })).toBe(false)
    expect(matchesFilter(stale!, { ...NO_FILTER, staleOnly: true })).toBe(true)
  })
})

describe('the Mine filter', () => {
  it("keeps the runs the reader pushed or set going, and nobody else's", () => {
    const [theirs] = groupByRun([entry({ run: makeRun({ id: 1, actor: { login: 'sam' } }) })])
    const [pushed] = groupByRun([entry({ run: makeRun({ id: 2, actor: { login: 'Dana-K' } }) })])
    const [rerun] = groupByRun([
      entry({ run: makeRun({ id: 3, actor: { login: 'sam' }, triggering_actor: { login: 'dana-k' } }) }),
    ])
    const mine = { ...NO_FILTER, mine: true }

    expect(matchesFilter(theirs!, mine, 'dana-k')).toBe(false)
    expect(matchesFilter(pushed!, mine, 'dana-k')).toBe(true)
    expect(matchesFilter(rerun!, mine, 'dana-k')).toBe(true)
    expect(matchesFilter(pushed!, mine, null)).toBe(false)
  })
})
