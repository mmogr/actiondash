import type { Basis } from '../model/forecast'
import { hedge } from './format'
import type { PoolMode } from './lanes'

/**
 * The sentence at the top of each pool that answers the question its state
 * raises, before any drawing: is anything waiting, and if so, for how long.
 * Pure, with the clock format passed in, so it can be tested.
 */

/** A queue that has sat this long beside a free slot is not just between polls. */
const STUCK_BESIDE_FREE_MS = 2 * 60_000

/** Within this of its usual end, a job is "due now" rather than given a time. */
const DUE_WINDOW_MS = 60_000

/**
 * What happens next to a running job, in the one form the timeline, the
 * tiles and the list all use, and never to the second: "ends ~10:09",
 * "due now", "4m over usual", or "no estimate yet". A job past its usual time
 * is not given an end at all, because nobody knows it.
 */
export function endNote(
  usualEnd: number | null,
  guessed: boolean,
  nowMs: number,
  clock: (ms: number) => string,
  minutes: (seconds: number) => string,
): string {
  if (usualEnd === null) return 'no estimate yet'
  const over = nowMs - usualEnd
  if (over >= DUE_WINDOW_MS) return `${minutes(over / 1000)} over usual`
  if (over > -DUE_WINDOW_MS) return 'due now'
  return `ends ~${clock(usualEnd)}${guessed ? ' (guess)' : ''}`
}

/** Whether an end note means the job could finish any moment, rather than at a time. */
export function isDue(note: string): boolean {
  return note === 'due now' || note.endsWith('over usual')
}

export interface VerdictInput {
  /** The pool's name, such as "macOS". */
  pool: string
  mode: PoolMode
  used: number
  cap: number | null
  queued: number
  /** How long the oldest waiting job has waited, in ms, or 0 when unknown. */
  waitedMs: number
  nextSlotAt: number | null
  nextSlotBasis: Basis
  queueClearsAt: number | null
  queueClearsBasis: Basis
  /** Running jobs well past their usual time. */
  overdue: number
  /** False when the headline tiles above already give the times. */
  withTimes: boolean
}

export interface Verdict {
  /** The answer, in a few words, shown in bold. */
  lead: string
  rest: string
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

export function poolVerdict(v: VerdictInput, clock: (ms: number) => string): Verdict | null {
  const { pool, used, cap, queued } = v
  const late =
    v.overdue > 0
      ? ` ${v.overdue} running ${plural(v.overdue, 'job is', 'jobs are')} well past ${plural(v.overdue, 'its', 'their')} usual time.`
      : ''
  const when = (at: number, basis: Basis) => `~${clock(at)}${hedge(basis)}`

  switch (v.mode) {
    case 'idle':
      return null

    case 'room':
      return {
        lead: 'Nothing waiting.',
        rest:
          (cap === null
            ? `${used} ${plural(used, 'job', 'jobs')} running.`
            : `${used} of ${cap} ${pool} slots in use, ${cap - used} free.`) + late,
      }

    case 'full': {
      const next =
        !v.withTimes || v.nextSlotAt === null
          ? ' A new job would have to wait for one.'
          : ` A new job would wait until ${when(v.nextSlotAt, v.nextSlotBasis)}.`
      return { lead: 'Nothing waiting,', rest: `but all ${cap} ${pool} slots are busy.${next}${late}` }
    }

    case 'queue': {
      const lead = `${queued} waiting`
      if (cap !== null && used < cap) {
        const free = cap - used
        const why =
          v.waitedMs >= STUCK_BESIDE_FREE_MS
            ? ' Jobs from repositories not watched here may be holding them, or the plan in Settings may be wrong.'
            : ' They should start shortly.'
        return {
          lead,
          rest: `although ${free} ${pool} ${plural(free, 'slot looks', 'slots look')} free.${why}${late}`,
        }
      }
      // Pools without a cap are named by the section title; "a Self-hosted runner" would jar.
      const forWhat = cap === null ? 'for a runner.' : `for ${cap} busy ${pool} slots.`
      let times = ''
      if (v.nextSlotAt === null) {
        times = ' No start times yet: they appear once jobs here have been seen to finish.'
      } else if (v.withTimes) {
        times = ` The next should start ${when(v.nextSlotAt, v.nextSlotBasis)}.`
        if (v.queueClearsAt !== null) times += ` All should be done ${when(v.queueClearsAt, v.queueClearsBasis)}.`
      }
      return { lead, rest: `${forWhat}${times}${late}` }
    }
  }
}
