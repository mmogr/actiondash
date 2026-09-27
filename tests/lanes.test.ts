import { describe, expect, it } from 'vitest'
import {
  captionLength,
  clockTicks,
  fitCaption,
  foldQueue,
  gaugeCells,
  headlineIndex,
  poolMode,
  positionsText,
  queueSegments,
  tickStep,
  timeWindow,
  wantsTimeline,
} from '../src/ui/lanes'

const MIN = 60_000
const NOW = Date.parse('2026-09-09T10:05:00Z')

describe('poolMode', () => {
  it('lets the state of the pool pick the question it answers', () => {
    expect(poolMode(0, 5, 0)).toBe('idle')
    // The user's case: plenty of room, nobody waiting.
    expect(poolMode(9, 40, 0)).toBe('room')
    expect(poolMode(5, 5, 0)).toBe('full')
    expect(poolMode(5, 5, 7)).toBe('queue')
    // Waiting beside a free slot is still a queue, and still worth drawing.
    expect(poolMode(4, 5, 2)).toBe('queue')
    // Self-hosted pools have no cap, so they are never full.
    expect(poolMode(12, null, 0)).toBe('room')
  })

  it('draws the timeline where something is or will be waiting, and where a pool is nearly full', () => {
    // The user's case: 9 of 40 with nobody waiting is left to the list.
    expect(wantsTimeline('room', 9, 40)).toBe(false)
    expect(wantsTimeline('idle', 0, 5)).toBe(false)
    expect(wantsTimeline('full', 5, 5)).toBe(true)
    expect(wantsTimeline('queue', 4, 5)).toBe(true)
    // A small pool keeps its drawing at 4 of 5, so it does not come and go
    // with every poll as the fifth slot is taken and freed.
    expect(wantsTimeline('room', 4, 5)).toBe(true)
    expect(wantsTimeline('room', 21, 40)).toBe(true)
    expect(wantsTimeline('room', 20, 40)).toBe(false)
    expect(wantsTimeline('room', 3, null)).toBe(false)
  })
})

describe('queueSegments', () => {
  const job = (run: number) => ({ run })

  it('groups neighbouring jobs of one run, keeping their places in line', () => {
    const segs = queueSegments([job(414), job(414), job(414), job(214), job(88)], (j) => j.run)

    expect(segs.map((s) => [s.items.length, s.from, s.to])).toEqual([
      [3, 1, 3],
      [1, 4, 4],
      [1, 5, 5],
    ])
  })

  it('shows a run twice when another run sits between its jobs, so order still reads downward', () => {
    const segs = queueSegments([job(1), job(2), job(1)], (j) => j.run)

    expect(segs.map((s) => [s.items[0]!.run, s.from])).toEqual([
      [1, 1],
      [2, 2],
      [1, 3],
    ])
  })
})

describe('foldQueue', () => {
  const segs = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ items: [n, n], from: n * 2 - 1, to: n * 2 }))
  const shape = (rows: ReturnType<typeof foldQueue<number>>) =>
    rows.map((r) => `${r.folded ? 'fold' : 'row'} ${r.seg.from}-${r.seg.to}`)

  it('keeps every row when they fit', () => {
    expect(foldQueue(segs.slice(0, 3), 3)).toEqual(segs.slice(0, 3).map((seg) => ({ seg, folded: false })))
  })

  it('folds the tail into one last row that still holds every job', () => {
    const rows = foldQueue(segs, 3)

    expect(shape(rows)).toEqual(['row 1-2', 'row 3-4', 'fold 5-16'])
    expect(rows[2]!.seg.items).toEqual([3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8])
  })

  it('keeps the reader at the back of the line in view, in order, between folded rows', () => {
    const mine = (seg: { from: number }) => seg.from === 11

    expect(shape(foldQueue(segs, 4, mine))).toEqual(['row 1-2', 'fold 3-10', 'row 11-12', 'fold 13-16'])
    // Last in line: nothing to fold after it.
    expect(shape(foldQueue(segs, 4, (seg) => seg.from === 15))).toEqual(['row 1-2', 'row 3-4', 'fold 5-14', 'row 15-16'])
    // Already among the rows shown: nothing changes.
    expect(shape(foldQueue(segs, 4, (seg) => seg.from === 1))).toEqual(['row 1-2', 'row 3-4', 'row 5-6', 'fold 7-16'])
  })
})

describe('positionsText', () => {
  it('says one place or a range', () => {
    expect(positionsText(7, 7)).toBe('7')
    expect(positionsText(1, 4)).toBe('1–4')
  })
})

describe('gaugeCells', () => {
  it('draws a cell for every slot, and none for a queue that is empty', () => {
    expect(gaugeCells(9, 40, 0)).toEqual({ slots: 40, used: 9, queued: 0, more: 0 })
  })

  it('draws a cell for every waiting job after the slots', () => {
    expect(gaugeCells(5, 5, 7)).toEqual({ slots: 5, used: 5, queued: 7, more: 0 })
  })

  it('stops a long line at a few times the pool and counts the rest', () => {
    expect(gaugeCells(5, 5, 16)).toEqual({ slots: 5, used: 5, queued: 16, more: 0 })
    expect(gaugeCells(5, 5, 40)).toEqual({ slots: 5, used: 5, queued: 20, more: 20 })
    expect(gaugeCells(9, 40, 30)).toEqual({ slots: 40, used: 9, queued: 30, more: 0 })
  })

  it('draws more slots than the cap when more were counted running', () => {
    expect(gaugeCells(6, 5, 0)?.slots).toBe(6)
  })

  it('gives up on cells for a pool too big to draw them', () => {
    expect(gaugeCells(120, 500, 0)).toBeNull()
  })
})

describe('timeWindow', () => {
  it('looks ahead at least a quarter of an hour, and back a third as far', () => {
    expect(timeWindow(NOW, null)).toEqual({ tMin: NOW - 5 * MIN, tMax: NOW + 15 * MIN })
  })

  it('reaches past the last forecast, within an hour', () => {
    expect(timeWindow(NOW, NOW + 28 * MIN).tMax).toBe(NOW + 30 * MIN)
    expect(timeWindow(NOW, NOW + 3 * 60 * MIN).tMax).toBe(NOW + 60 * MIN)
  })

  it('never looks back more than ten minutes', () => {
    expect(timeWindow(NOW, NOW + 50 * MIN).tMin).toBe(NOW - 10 * MIN)
  })
})

describe('clockTicks', () => {
  it('labels round clock times and leaves room around now', () => {
    const ticks = clockTicks(NOW - 5 * MIN, NOW + 15 * MIN, NOW + 1 * MIN, 5 * MIN, 2 * MIN)

    expect(ticks.map((t) => (t - NOW) / MIN)).toEqual([-5, 5, 10, 15])
  })

  it('spaces ticks further apart as the window grows', () => {
    expect(tickStep(0, 20 * MIN)).toBe(5 * MIN)
    expect(tickStep(0, 45 * MIN)).toBe(10 * MIN)
    expect(tickStep(0, 70 * MIN)).toBe(15 * MIN)
  })
})

describe('fitCaption', () => {
  const parts = { label: 'ios-client #213 · archive', tags: ['superseded'], note: 'done ~10:09' }

  it('leaves a caption that fits alone', () => {
    expect(fitCaption(parts, 60)).toEqual(parts)
    expect(captionLength(parts)).toBe(25 + 2 + 10 + 2 + 11)
  })

  it('shortens the label first, keeping the tags and the note whole', () => {
    const fitted = fitCaption(parts, 40)

    expect(fitted.tags).toEqual(['superseded'])
    expect(fitted.note).toBe('done ~10:09')
    expect(fitted.label).toBe('ios-client #21…')
    expect(captionLength(fitted)).toBe(40)
  })

  it('tries the short form of the label before cutting anything', () => {
    const withShort = { ...parts, short: '#213 · archive' }

    expect(fitCaption(withShort, 40)).toEqual({ label: '#213 · archive', tags: ['superseded'], note: 'done ~10:09' })
    // Too long even in its short form: the note goes before the short form is cut.
    expect(fitCaption(withShort, 30)).toEqual({ label: '#213 · archive', tags: ['superseded'], note: '' })
  })

  it('drops the note before cutting the label to nothing', () => {
    const fitted = fitCaption(parts, 30)

    expect(fitted.note).toBe('')
    expect(fitted.label.startsWith('ios-client')).toBe(true)
    expect(captionLength(fitted)).toBeLessThanOrEqual(30)
  })
})

describe('headlineIndex', () => {
  it('puts the tiles above the longest queue, whichever pool it is in', () => {
    expect(
      headlineIndex([
        { used: 0, cap: 5, queued: 0 },
        { used: 40, cap: 40, queued: 3 },
      ]),
    ).toBe(1)
  })

  it('falls back to a full pool, and to none when every pool has room', () => {
    expect(
      headlineIndex([
        { used: 2, cap: 5, queued: 0 },
        { used: 40, cap: 40, queued: 0 },
      ]),
    ).toBe(1)
    // The user's case: macOS idle, Linux 9 of 40. Nothing is under pressure.
    expect(
      headlineIndex([
        { used: 0, cap: 5, queued: 0 },
        { used: 9, cap: 40, queued: 0 },
      ]),
    ).toBe(-1)
  })
})
