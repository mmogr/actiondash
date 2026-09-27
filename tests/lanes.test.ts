import { describe, expect, it } from 'vitest'
import { CHAR_W, mergeNarrow, placeLabel } from '../src/ui/lanes'

/** Room for a label n characters long, with its padding. */
const fits = (n: number) => n * CHAR_W + 10

describe('placeLabel', () => {
  it('puts a label that fits on the bar', () => {
    const p = placeLabel('Build', { x1: 100, x2: 100 + fits(5), before: 0, after: 0 })

    expect(p).toMatchObject({ text: 'Build', spot: 'on-bar', anchor: 'start' })
  })

  it('puts a whole label beside the bar rather than cutting it short', () => {
    const name = 'UI Tests (iPhone 15)'
    const narrowBar = { x1: 300, x2: 340 }

    expect(placeLabel(name, { ...narrowBar, before: 0, after: fits(name.length) })).toMatchObject({
      text: name,
      spot: 'after',
    })
    expect(placeLabel(name, { ...narrowBar, before: fits(name.length), after: 0 })).toMatchObject({
      text: name,
      spot: 'before',
      anchor: 'end',
      x: 295,
    })
  })

  it('falls back to the short form on the bar, such as a queue position', () => {
    const p = placeLabel('11 · UI Tests (iPad)', { x1: 0, x2: fits(2), before: 0, after: 0 }, '11')

    expect(p).toMatchObject({ text: '11', spot: 'on-bar' })
  })

  it('shortens only as a last resort, in the roomiest space', () => {
    const p = placeLabel('UI Tests (iPhone 15)', { x1: 200, x2: 230, before: fits(10), after: 0 })

    expect(p?.spot).toBe('before')
    expect(p?.text.endsWith('…')).toBe(true)
    expect(p!.text.length).toBeGreaterThanOrEqual(5)
  })

  it('leaves the label off when too little would be left to read', () => {
    expect(placeLabel('UI Tests (iPhone 15)', { x1: 0, x2: 30, before: 20, after: 10 })).toBeNull()
  })
})

describe('mergeNarrow', () => {
  const bar = (item: string, x1: number, x2: number) => ({ item, x1, x2 })

  it('joins a run of bars too narrow to tell apart', () => {
    const spans = mergeNarrow([bar('a', 0, 5), bar('b', 5, 10), bar('c', 10, 14)], 18)

    expect(spans).toEqual([{ items: ['a', 'b', 'c'], x1: 0, x2: 14 }])
  })

  it('keeps a bar wide enough to read on its own, and starts again after it', () => {
    const spans = mergeNarrow([bar('a', 0, 5), bar('wide', 5, 60), bar('b', 60, 64), bar('c', 64, 68)], 18)

    expect(spans.map((s) => s.items)).toEqual([['a'], ['wide'], ['b', 'c']])
  })

  it('does not join narrow bars with a gap between them', () => {
    const spans = mergeNarrow([bar('a', 0, 5), bar('b', 40, 45)], 18)

    expect(spans.map((s) => s.items)).toEqual([['a'], ['b']])
  })
})
