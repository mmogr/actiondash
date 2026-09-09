import { describe, expect, it } from 'vitest'
import { capFor, inferPlan, PLANS } from '../src/model/plans'

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

  it('suggests a larger plan once the macOS ceiling is exceeded', () => {
    // Eight concurrent macOS jobs are impossible on any 5-macOS plan.
    expect(inferPlan({ macos: 8, total: 8 }, 'free')).toBe('enterprise')
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
