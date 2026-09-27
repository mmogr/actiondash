/**
 * Layout rules for a pool's picture: which view its state calls for, how the
 * queue is cut into rows, what the gauge draws, the time window and its ticks,
 * and how a row's caption is fitted. Pure, in pixels or epoch ms, so it can be
 * tested.
 */

/**
 * The question a pool's state raises, which decides what is drawn.
 *
 * - idle: nothing to say beyond "nothing running".
 * - room: slots to spare and nobody waiting. The reader only needs to hear
 *   that, and how much room is left; a timeline would restate the list.
 * - full: every slot held, nobody waiting yet. When does the next one free?
 * - queue: jobs waiting. Who is next, where is mine, when does it start?
 */
export type PoolMode = 'idle' | 'room' | 'full' | 'queue'

export function poolMode(used: number, cap: number | null, queued: number): PoolMode {
  if (queued > 0) return 'queue'
  if (used === 0) return 'idle'
  return cap !== null && used >= cap ? 'full' : 'room'
}

/**
 * Whether a pool's state calls for the timeline rather than the gauge alone.
 * A full or queued pool always does. A pool with room does too while it is
 * nearly full, so a small pool going between 4 of 5 and 5 of 5 does not grow
 * and shrink a drawing on every poll; only a pool with half its slots free,
 * such as Linux at 9 of 40, leaves its running jobs to the list.
 */
export function wantsTimeline(mode: PoolMode, used: number, cap: number | null): boolean {
  if (mode === 'full' || mode === 'queue') return true
  if (mode === 'idle' || cap === null) return false
  return cap - used < cap / 2
}

/** Consecutive queued jobs of one run, with their one-based queue positions. */
export interface QueueSegment<T> {
  items: T[]
  from: number
  to: number
}

/**
 * Cuts the queue, oldest first, into runs of consecutive jobs from the same
 * workflow run. A run whose jobs are not next to each other in line, such as
 * one whose later jobs were created after another run's, appears once for
 * each stretch, so position always reads top to bottom.
 */
export function queueSegments<T>(queued: readonly T[], runOf: (item: T) => number): QueueSegment<T>[] {
  const out: QueueSegment<T>[] = []
  queued.forEach((item, i) => {
    const last = out[out.length - 1]
    if (last && runOf(last.items[0]!) === runOf(item)) {
      last.items.push(item)
      last.to = i + 1
    } else {
      out.push({ items: [item], from: i + 1, to: i + 1 })
    }
  })
  return out
}

export interface QueueRowSpec<T> {
  seg: QueueSegment<T>
  /** True for a row standing in for several runs, which says how many it holds. */
  folded: boolean
}

function join<T>(segs: readonly QueueSegment<T>[]): QueueSegment<T> {
  return { items: segs.flatMap((s) => s.items), from: segs[0]!.from, to: segs[segs.length - 1]!.to }
}

/**
 * Keeps at most `max` rows. Rows past the limit fold into one row that says
 * how many jobs it holds, so a long queue is never cut off without saying
 * how much is left. A pinned row, the reader's own run, is always shown where
 * it stands in line, with a folded row before and after it as needed, so
 * order still reads top to bottom.
 */
export function foldQueue<T>(
  segments: readonly QueueSegment<T>[],
  max: number,
  pinned: (seg: QueueSegment<T>) => boolean = () => false,
): QueueRowSpec<T>[] {
  const row = (seg: QueueSegment<T>, folded = false): QueueRowSpec<T> => ({ seg, folded })
  if (segments.length <= max) return segments.map((s) => row(s))
  const pin = segments.findIndex(pinned)
  if (pin === -1 || pin < max - 1) {
    const keep = Math.max(0, max - 1)
    return [...segments.slice(0, keep).map((s) => row(s)), row(join(segments.slice(keep)), true)]
  }
  const after = segments.slice(pin + 1)
  const keep = Math.max(0, max - (after.length > 0 ? 3 : 2))
  return [
    ...segments.slice(0, keep).map((s) => row(s)),
    row(join(segments.slice(keep, pin)), true),
    row(segments[pin]!),
    ...(after.length > 0 ? [row(join(after), true)] : []),
  ]
}

/** Queue positions as a reader says them: "3", or "1–4". */
export function positionsText(from: number, to: number): string {
  return from === to ? String(from) : `${from}–${to}`
}

export interface GaugeCells {
  /** Slots drawn: the cap, or more if more jobs were counted running. */
  slots: number
  used: number
  /** Waiting jobs drawn as cells after the slots. */
  queued: number
  /** Waiting jobs past the cells, said as "+N". */
  more: number
}

/**
 * One cell per slot, then one per waiting job, so a full pool with a line
 * behind it looks like one. Null when the pool has too many slots for cells
 * to stay visible, where a plain proportional bar is drawn instead.
 */
export function gaugeCells(used: number, cap: number, queued: number, maxSlots = 60): GaugeCells | null {
  const slots = Math.max(cap, used)
  if (slots > maxSlots || slots === 0) return null
  // The line may run to a few times the pool, and no further: past that its
  // length stops meaning anything and cells shrink to nothing.
  const room = Math.min(Math.max(slots * 4, 20), maxSlots)
  const shown = Math.min(queued, room)
  return { slots, used, queued: shown, more: queued - shown }
}

export interface TimeWindow {
  tMin: number
  tMax: number
}

const MIN = 60_000

/**
 * The window a timeline covers. It runs far enough ahead to show the last
 * thing forecast, within bounds, and looks back only a third as far: the
 * past is there for context, the list below already says how long each job
 * has run, and the future is what the reader came for.
 */
export function timeWindow(
  nowMs: number,
  latest: number | null,
  { minAhead = 15 * MIN, maxAhead = 60 * MIN, maxBack = 10 * MIN, backShare = 1 / 3 } = {},
): TimeWindow {
  const wanted = latest === null ? 0 : latest + 2 * MIN - nowMs
  const ahead = Math.min(maxAhead, Math.max(minAhead, wanted))
  const back = Math.min(maxBack, ahead * backShare)
  return { tMin: nowMs - back, tMax: nowMs + ahead }
}

/**
 * Round clock times to label, every `stepMs`, leaving out any close enough
 * to now that the two labels would collide. Epoch multiples of five minutes
 * are round in every time zone whose offset is a multiple of five minutes,
 * which is every zone in use.
 */
export function clockTicks(tMin: number, tMax: number, nowMs: number, stepMs: number, clearMs: number): number[] {
  const out: number[] = []
  for (let t = Math.ceil(tMin / stepMs) * stepMs; t <= tMax; t += stepMs) {
    if (Math.abs(t - nowMs) >= clearMs) out.push(t)
  }
  return out
}

/** The tick spacing for a window: five minutes, or ten past half an hour, or fifteen past an hour. */
export function tickStep(tMin: number, tMax: number): number {
  const span = tMax - tMin
  return span > 60 * MIN ? 15 * MIN : span > 30 * MIN ? 10 * MIN : 5 * MIN
}

export interface CaptionParts {
  /** Who the row is: shortened first when the line is too long. */
  label: string
  /** A shorter way of saying who, such as without the repository, tried before the label is cut. */
  short?: string
  /** Short fixed words such as "superseded" or "you", kept whole. */
  tags: string[]
  /** What happens next, such as "done ~10:08"; dropped only as a last resort. */
  note: string
}

/** Characters a caption takes, with a two-character gap between parts. */
export function captionLength({ label, tags, note }: CaptionParts): number {
  return [label, ...tags, note].filter(Boolean).reduce((n, s, i) => n + s.length + (i > 0 ? 2 : 0), 0)
}

/** A label shorter than this is not worth keeping over the note. */
const MIN_LABEL = 10

/**
 * Fits a caption into `chars` characters. The short form of the label is
 * tried first; then the label is shortened, since the reader can find the
 * full name in the list; then the note goes; then the label is cut further.
 * Tags are never cut: they are why the row stands out.
 */
export function fitCaption(parts: CaptionParts, chars: number): CaptionParts {
  const cut = (text: string, n: number) => (text.length <= n ? text : `${text.slice(0, Math.max(1, n - 1))}…`)
  if (captionLength(parts) <= chars) return parts
  if (parts.short !== undefined && parts.short.length < parts.label.length) {
    return fitCaption({ label: parts.short, tags: parts.tags, note: parts.note }, chars)
  }
  const over = captionLength(parts) - chars
  const shorter = parts.label.length - over
  if (shorter >= MIN_LABEL) return { ...parts, label: cut(parts.label, shorter) }
  const withoutNote = { ...parts, note: '' }
  if (captionLength(withoutNote) <= chars) return withoutNote
  const left = parts.label.length - (captionLength(withoutNote) - chars)
  return { ...withoutNote, label: cut(parts.label, Math.max(1, left)) }
}

/**
 * Which pool gets the headline tiles: the one with the longest queue, or,
 * with nobody waiting anywhere, the first that is full. -1 when no pool is
 * under pressure, since "next slot" and "queue clears" then answer nothing.
 */
export function headlineIndex(pools: readonly { used: number; cap: number | null; queued: number }[]): number {
  let best = -1
  pools.forEach((p, i) => {
    if (p.queued > 0 && (best === -1 || p.queued > pools[best]!.queued)) best = i
  })
  if (best !== -1) return best
  return pools.findIndex((p) => p.cap !== null && p.used > 0 && p.used >= p.cap)
}
