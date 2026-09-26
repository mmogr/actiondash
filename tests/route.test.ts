import { describe, expect, it } from 'vitest'
import { parseHash } from '../src/ui/route'

describe('parseHash', () => {
  it('reads a screen', () => {
    expect(parseHash('#trends')).toEqual({ tab: 'trends' })
    expect(parseHash('#now')).toEqual({ tab: 'now' })
  })

  it('reads a link to one run', () => {
    expect(parseHash('#run=26512345678')).toEqual({ run: 26512345678 })
  })

  it('ignores anything else', () => {
    expect(parseHash('')).toBeNull()
    expect(parseHash('#run=abc')).toBeNull()
    expect(parseHash('#run=')).toBeNull()
    expect(parseHash('#somewhere')).toBeNull()
  })
})
