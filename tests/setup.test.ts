import { describe, expect, it } from 'vitest'
import { joinList, keptList, ownersOf, sameAccount, sameSelection, watchPatch } from '../src/model/setup'

describe('ownersOf', () => {
  it('counts the accounts behind a selection, largest first', () => {
    expect(ownersOf(['acme/app', 'acme/site', 'dana/dotfiles'])).toEqual([
      { owner: 'acme', count: 2 },
      { owner: 'dana', count: 1 },
    ])
    expect(ownersOf([])).toEqual([])
  })
})

describe('sameSelection', () => {
  it('ignores order and case', () => {
    const stored = [
      { owner: 'acme', name: 'app' },
      { owner: 'acme', name: 'site' },
    ]

    expect(sameSelection(stored, new Set(['Acme/Site', 'acme/app']))).toBe(true)
    expect(sameSelection(stored, new Set(['acme/app']))).toBe(false)
    expect(sameSelection(stored, new Set(['acme/app', 'acme/infra']))).toBe(false)
  })
})

describe('sameAccount', () => {
  it('lets a token for the same account, or an unknown one, go straight back', () => {
    expect(sameAccount('dana-k', 'Dana-K')).toBe(true)
    expect(sameAccount(null, 'dana-k')).toBe(true)
    expect(sameAccount('dana-k', 'sam')).toBe(false)
  })
})

describe('keptList', () => {
  it('says what a rejected token leaves in place', () => {
    expect(joinList(keptList({ repoCount: 4, planLabel: 'Pro', learnedJobs: 37, hasHistory: true }))).toBe(
      '4 repositories, the Pro plan, learned durations for 37 jobs and occupancy history',
    )
    expect(joinList(keptList({ repoCount: 1, planLabel: 'Free', learnedJobs: 0, hasHistory: false }))).toBe(
      '1 repository and the Free plan',
    )
  })
})

describe('watchPatch', () => {
  const app = { owner: 'acme', name: 'app' }
  const site = { owner: 'acme', name: 'site' }
  const lib = { owner: 'other', name: 'lib' }

  it('keeps what was seen running while the owners and the plan stay the same', () => {
    expect(watchPatch([app], 'pro', [app], 'pro')).toStrictEqual({ repos: [app], plan: 'pro' })
    // Another repository under an owner already watched draws on the same slots.
    expect(watchPatch([app], 'pro', [app, site], 'pro')).toStrictEqual({ repos: [app, site], plan: 'pro' })
  })

  it('forgets what was seen running when the owners change', () => {
    expect(watchPatch([app], 'pro', [lib], 'pro')).toStrictEqual({ repos: [lib], plan: 'pro', observedMax: {} })
    expect(watchPatch([app], 'pro', [app, lib], 'pro')).toStrictEqual({
      repos: [app, lib],
      plan: 'pro',
      observedMax: {},
    })
    expect(watchPatch([], 'free', [app], 'free')).toStrictEqual({ repos: [app], plan: 'free', observedMax: {} })
  })

  it('forgets what was seen running when the plan changes', () => {
    expect(watchPatch([app], 'pro', [app], 'team')).toStrictEqual({ repos: [app], plan: 'team', observedMax: {} })
  })
})
