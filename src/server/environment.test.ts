import { describe, expect, it } from 'vitest'
import { parseServerPort } from './environment'

describe('parseServerPort', () => {
  it('uses the fallback only when the variable is unset', () => {
    expect(parseServerPort(undefined, 'PORT', 8080)).toBe(8080)
    expect(parseServerPort('', 'PORT', 8080)).toBe(8080)
  })

  it('validates the complete listen-port range', () => {
    expect(parseServerPort('8443', 'PORT', 8080)).toBe(8443)
    expect(() => parseServerPort('not-a-port', 'PORT', 8080)).toThrow('PORT')
    expect(() => parseServerPort('0', 'PORT', 8080)).toThrow('PORT')
    expect(
      parseServerPort('0', 'MOTRIX_MDXP_PORT', 16801, { allowZero: true })
    ).toBe(0)
  })
})
