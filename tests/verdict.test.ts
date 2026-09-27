import { describe, expect, it } from 'vitest'
import { endNote, isDue, poolVerdict, type VerdictInput } from '../src/ui/verdict'

const NOW = Date.parse('2026-09-09T10:05:00Z')
const MIN = 60_000
/** A fixed, locale-free clock, so the sentences can be compared whole. */
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16)

function input(over: Partial<VerdictInput>): VerdictInput {
  return {
    pool: 'macOS',
    mode: 'queue',
    used: 5,
    cap: 5,
    queued: 7,
    waitedMs: 9 * MIN,
    nextSlotAt: NOW + MIN,
    nextSlotBasis: 'learned',
    queueClearsAt: NOW + 23 * MIN,
    queueClearsBasis: 'learned',
    overdue: 0,
    withTimes: true,
    ...over,
  }
}

const say = (over: Partial<VerdictInput>) => {
  const v = poolVerdict(input(over), clock)
  return v && `${v.lead} ${v.rest}`
}

describe('endNote', () => {
  const minutes = (s: number) => `${Math.round(s / 60)}m`
  const say = (usualEnd: number | null, guessed = false) => endNote(usualEnd, guessed, NOW, clock, minutes)

  it('gives a clock time while the usual end is still ahead, and says when it is a guess', () => {
    expect(say(NOW + 4 * MIN)).toBe('ends ~10:09')
    expect(say(NOW + 4 * MIN, true)).toBe('ends ~10:09 (guess)')
  })

  it('says "due now" around the usual end rather than counting seconds', () => {
    expect(say(NOW + 50_000)).toBe('due now')
    expect(say(NOW - 50_000)).toBe('due now')
  })

  it('says how far over a job is, and never invents an end for it', () => {
    expect(say(NOW - 4 * MIN)).toBe('4m over usual')
    expect(say(null)).toBe('no estimate yet')
  })

  it('knows which notes mean the job could finish any moment', () => {
    expect(isDue('due now')).toBe(true)
    expect(isDue('4m over usual')).toBe(true)
    expect(isDue('ends ~10:09')).toBe(false)
    expect(isDue('no estimate yet')).toBe(false)
  })
})

describe('poolVerdict', () => {
  it('says plainly that nothing is waiting in a pool with room, and how much room', () => {
    expect(say({ pool: 'Linux', mode: 'room', used: 9, cap: 40, queued: 0 })).toBe(
      'Nothing waiting. 9 of 40 Linux slots in use, 31 free.',
    )
  })

  it('says how many running jobs are well past their usual time', () => {
    expect(say({ pool: 'Linux', mode: 'room', used: 9, cap: 40, queued: 0, overdue: 3 })).toBe(
      'Nothing waiting. 9 of 40 Linux slots in use, 31 free. 3 running jobs are well past their usual time.',
    )
  })

  it('warns that a full pool would make a new job wait, and until when', () => {
    expect(say({ mode: 'full', queued: 0 })).toBe(
      'Nothing waiting, but all 5 macOS slots are busy. A new job would wait until ~10:06.',
    )
  })

  it('counts the queue and gives its times when no tiles above do', () => {
    expect(say({})).toBe('7 waiting for 5 busy macOS slots. The next should start ~10:06. All should be done ~10:28.')
    expect(say({ withTimes: false })).toBe('7 waiting for 5 busy macOS slots.')
  })

  it('says "or later" for a time behind an overrunning job, and "guess" for a borrowed duration', () => {
    expect(say({ nextSlotBasis: 'floor', queueClearsBasis: 'floor' })).toBe(
      '7 waiting for 5 busy macOS slots. The next should start ~10:06 or later. All should be done ~10:28 or later.',
    )
    expect(say({ nextSlotBasis: 'guessed', queueClearsBasis: 'guessed' })).toBe(
      '7 waiting for 5 busy macOS slots. The next should start ~10:06 (guess). All should be done ~10:28 (guess).',
    )
  })

  it('admits it has no start times rather than inventing them', () => {
    expect(say({ nextSlotAt: null, queueClearsAt: null, withTimes: false })).toBe(
      '7 waiting for 5 busy macOS slots. No start times yet: they appear once jobs here have been seen to finish.',
    )
  })

  it('explains a queue that has sat beside a free slot, and not one that has only just arrived', () => {
    expect(say({ used: 4, queued: 2, waitedMs: 30_000 })).toBe(
      '2 waiting although 1 macOS slot looks free. They should start shortly.',
    )
    expect(say({ used: 4, queued: 2, waitedMs: 5 * MIN })).toMatch(
      /^2 waiting although 1 macOS slot looks free\. Jobs from repositories not watched here/,
    )
  })

  it('speaks of a pool without a cap by what is running, not by slots', () => {
    expect(say({ pool: 'Self-hosted', mode: 'room', used: 3, cap: null, queued: 0 })).toBe('Nothing waiting. 3 jobs running.')
    expect(say({ pool: 'Self-hosted', cap: null, queued: 2, withTimes: false })).toBe('2 waiting for a runner.')
  })

  it('says nothing for an idle pool, which has its own line', () => {
    expect(say({ mode: 'idle', used: 0, queued: 0 })).toBeNull()
  })
})
