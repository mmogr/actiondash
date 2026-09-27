/**
 * Layout rules for the slot lanes: where a bar's label goes, and which queued
 * bars are too narrow to draw apart. Pure, in pixels, so it can be tested.
 */

/** Width of one character of lane text: 12px monospace is about 0.6em wide. */
export const CHAR_W = 7.2
/** Space between a bar's edge and its label. */
const PAD = 5
/** Fewer characters than this is not worth showing; the tooltip has the name. */
const MIN_CHARS = 5

export type LabelSpot = 'on-bar' | 'after' | 'before'

export interface Placement {
  text: string
  x: number
  anchor: 'start' | 'end'
  spot: LabelSpot
}

export interface LabelRoom {
  /** The bar's left and right edges. */
  x1: number
  x2: number
  /** Empty track before the bar, back to the last thing drawn. */
  before: number
  /** Empty track after the bar, up to the next thing drawn. */
  after: number
}

function widthOf(text: string, charW: number): number {
  return text.length * charW
}

/** Whether a width fits a space, allowing half a pixel for rounding. */
function fitsIn(need: number, room: number): boolean {
  return need <= room + 0.5
}

/**
 * Where a label goes. Whole on the bar when it fits; else whole on the empty
 * track after the bar, or before it; else the short form on the bar, when
 * there is one; else shortened in whichever space is roomiest, and left off
 * when too little would remain to read.
 */
export function placeLabel(
  label: string,
  room: LabelRoom,
  short: string | null = null,
  charW = CHAR_W,
): Placement | null {
  const { x1, x2, before, after } = room
  const onBarRoom = x2 - x1 - 2 * PAD
  const onBar = (text: string): Placement => ({ text, x: x1 + PAD, anchor: 'start', spot: 'on-bar' })
  const afterBar = (text: string): Placement => ({ text, x: x2 + PAD, anchor: 'start', spot: 'after' })
  const beforeBar = (text: string): Placement => ({ text, x: x1 - PAD, anchor: 'end', spot: 'before' })

  const need = widthOf(label, charW)
  if (fitsIn(need, onBarRoom)) return onBar(label)
  if (fitsIn(need, after - PAD)) return afterBar(label)
  if (fitsIn(need, before - PAD)) return beforeBar(label)
  if (short !== null && fitsIn(widthOf(short, charW), onBarRoom)) return onBar(short)

  const spots = [
    { room: onBarRoom, place: onBar },
    { room: after - PAD, place: afterBar },
    { room: before - PAD, place: beforeBar },
  ].sort((a, b) => b.room - a.room)
  const best = spots[0]!
  const chars = Math.floor((best.room + 0.5) / charW)
  if (chars < MIN_CHARS) return null
  return best.place(`${label.slice(0, chars - 1)}…`)
}

export interface Span<T> {
  items: T[]
  x1: number
  x2: number
}

/**
 * Joins runs of bars too narrow to tell apart into one span, so short queued
 * jobs neither overlap one another nor claim a precision the forecast does not
 * have. Bars come in start order. A bar wide enough to read stands alone.
 */
export function mergeNarrow<T>(
  bars: readonly { item: T; x1: number; x2: number }[],
  minWidth: number,
): Span<T>[] {
  const out: Span<T>[] = []
  let open: Span<T> | null = null
  for (const bar of bars) {
    const narrow = bar.x2 - bar.x1 < minWidth
    if (narrow && open !== null && bar.x1 <= open.x2 + 1) {
      open.items.push(bar.item)
      open.x2 = Math.max(open.x2, bar.x2)
      continue
    }
    const span: Span<T> = { items: [bar.item], x1: bar.x1, x2: bar.x2 }
    out.push(span)
    open = narrow ? span : null
  }
  return out
}
