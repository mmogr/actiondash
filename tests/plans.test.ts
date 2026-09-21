import { describe, expect, it } from 'vitest'
import { capFor, inferPlan, planExplains, PLANS } from '../src/model/plans'

describe('capFor', () => {
  it('gives macOS its own smaller ceiling', () => {
    expect(capFor(PLANS.free, 'macos')).toBe(5)
    expect(capFor(PLANS.free, 'linux')).toBe(20)
  })

  it('reports no ceiling where the account does not impose one', () => {
    expect(capFor(PLANS.free, 'self-hosted')).toBeNull()
    expect(capFor(PLANS.free, 'other')).toBeNull()
  })
})

describe('inferPlan', () => {
  it('stays quiet while observations fit the chosen plan', () => {
    expect(inferPlan({ macos: 5, total: 20 }, 'free')).toBeNull()
    expect(inferPlan({}, 'free')).toBeNull()
  })

  it('refuses to pick a plan from a macOS excess alone', () => {
    // Free, Pro and Team are identical on macOS, so eight says nothing about
    // which of them this is - only that the count is wrong.
    expect(inferPlan({ macos: 8, total: 8 }, 'free')).toBeNull()
    expect(inferPlan({ macos: 8, total: 8 }, 'pro')).toBeNull()
  })

  it('suggests Enterprise when the total corroborates the macOS excess', () => {
    expect(inferPlan({ macos: 8, total: 120 }, 'pro')).toBe('enterprise')
  })

  it('suggests nothing beyond every published ceiling', () => {
    // Support can raise a limit on request, and a broken counter looks the
    // same from here. Neither is an argument for changing plan.
    expect(inferPlan({ macos: 80, total: 80 }, 'enterprise')).toBeNull()
  })

  it('leaves an impossible macOS reading neither explained nor suggestible', () => {
    // This pair is what selects the dashboard's suspect-reading banner.
    expect(planExplains(PLANS.pro, { macos: 8, total: 8 })).toBe(false)
    expect(inferPlan({ macos: 8, total: 8 }, 'pro')).toBeNull()
  })

  it('suggests the smallest plan that explains the total', () => {
    expect(inferPlan({ macos: 3, total: 35 }, 'free')).toBe('pro')
    expect(inferPlan({ macos: 3, total: 55 }, 'free')).toBe('team')
    expect(inferPlan({ macos: 3, total: 200 }, 'pro')).toBe('enterprise')
  })

  it('never suggests a downgrade, since a quiet account proves nothing', () => {
    expect(inferPlan({ macos: 1, total: 2 }, 'enterprise')).toBeNull()
    expect(inferPlan({ macos: 0, total: 0 }, 'team')).toBeNull()
  })

  it('uses the recorded total rather than summing per-class peaks', () => {
    // 20 Linux and 5 macOS peaks that never coincided still fit Free.
    expect(inferPlan({ macos: 5, linux: 20, total: 20 }, 'free')).toBeNull()
  })
})

describe('inferPlan, over the whole PLANS table', () => {
  // Derived from the published limits rather than from examples, so it covers
  // readings nobody thought to write down, and it changes when the table does.
  const order = Object.values(PLANS).sort((a, b) => a.total - b.total || a.macos - b.macos)
  const dimensions = ['macos', 'total'] as const

  it('never jumps past plans ruled out only where they match the current one', () => {
    // A plan between the current one and the suggestion that failed only on a
    // ceiling it shares with the current plan shows that dimension cannot tell
    // the plans apart. Naming anything beyond it is guessing, and this is the
    // shape of the bug that told a Pro account it must be on Enterprise.
    const violations: string[] = []
    for (const current of order) {
      for (const dim of dimensions) {
        for (let n = current[dim] + 1; n <= current[dim] + 60; n++) {
          const observed = { [dim]: n }
          const named = inferPlan(observed, current.id)
          if (named === null) continue
          const between = order.slice(order.indexOf(current) + 1, order.indexOf(PLANS[named]))
          const unjustified =
            between.length > 0 &&
            between.every((plan) =>
              dimensions
                .filter((d) => plan[d] < (observed[d] ?? 0))
                .every((d) => plan[d] === current[d]),
            )
          if (unjustified) violations.push(`${current.id} ${dim}=${n} -> ${named}`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})

describe('planExplains', () => {
  it('accepts an observation within both ceilings', () => {
    expect(planExplains(PLANS.pro, { macos: 5, total: 40 })).toBe(true)
    expect(planExplains(PLANS.pro, {})).toBe(true)
  })

  it('rejects an observation over either ceiling', () => {
    expect(planExplains(PLANS.pro, { macos: 6, total: 6 })).toBe(false)
    expect(planExplains(PLANS.pro, { macos: 1, total: 41 })).toBe(false)
  })
})
