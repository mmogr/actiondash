import { describe, expect, it } from 'vitest'
import { adviceFor } from '../src/model/advice'

describe('adviceFor', () => {
  it('says nothing while the chosen plan explains what was seen', () => {
    expect(adviceFor({ macos: 5, total: 40 }, 'pro', false)).toEqual({ kind: 'none' })
    expect(adviceFor({}, 'free', false)).toEqual({ kind: 'none' })
  })

  it('suggests the plan that explains a total the chosen one cannot', () => {
    expect(adviceFor({ macos: 3, total: 55 }, 'pro', false)).toEqual({
      kind: 'suggest',
      plan: 'team',
      dimension: 'total',
    })
  })

  it('names macOS as the reason when that is the ceiling exceeded', () => {
    expect(adviceFor({ macos: 8, total: 120 }, 'pro', false)).toEqual({
      kind: 'suggest',
      plan: 'enterprise',
      dimension: 'macos',
    })
  })

  it('treats a macOS excess no plan explains as a counting problem', () => {
    // The shape of the reading from PR #1: a Pro account, eight macOS jobs.
    expect(adviceFor({ macos: 8, total: 8 }, 'pro', false)).toMatchObject({
      kind: 'suspect',
      dimension: 'macos',
    })
  })

  it('stays quiet about a suspect reading once dismissed', () => {
    expect(adviceFor({ macos: 8, total: 8 }, 'pro', true)).toEqual({ kind: 'none' })
  })

  it('does not let dismissal hide a plan suggestion', () => {
    expect(adviceFor({ macos: 3, total: 55 }, 'pro', true).kind).toBe('suggest')
  })

  it('distinguishes a reading past every plan from one only Enterprise explains', () => {
    // "No plan below Enterprise allows" is false for an Enterprise account, and
    // an understatement for anyone once the count passes Enterprise's ceiling.
    expect(adviceFor({ macos: 8, total: 8 }, 'pro', false)).toMatchObject({ pastEveryPlan: false })
    expect(adviceFor({ macos: 60, total: 60 }, 'enterprise', false)).toMatchObject({
      kind: 'suspect',
      dimension: 'macos',
      pastEveryPlan: true,
    })
    expect(adviceFor({ macos: 60, total: 60 }, 'pro', false)).toMatchObject({ pastEveryPlan: true })
  })
})

