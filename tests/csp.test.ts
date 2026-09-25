import { describe, expect, it } from 'vitest'
import { DEV_CSP, PROD_CSP } from '../src/csp'

describe('content security policy', () => {
  it('lets both policies load the manifest and the service worker from this origin only', () => {
    for (const csp of [PROD_CSP, DEV_CSP]) {
      expect(csp).toContain("manifest-src 'self'")
      expect(csp).toContain("worker-src 'self'")
    }
  })

  it('keeps the production policy free of every relaxation', () => {
    expect(PROD_CSP).not.toMatch(/unsafe|localhost|ws:|data:|\*/)
  })
})
