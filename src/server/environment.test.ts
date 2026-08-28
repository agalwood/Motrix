import { describe, expect, it } from 'vitest'
import { parseServerBoolean, parseServerPort } from './environment'

describe('parseServerBoolean', () => {
  it('uses the fallback when the variable is unset or blank', () => {
    expect(parseServerBoolean(undefined, 'FEATURE_ENABLED')).toBe(false)
    expect(parseServerBoolean('', 'FEATURE_ENABLED')).toBe(false)
    expect(parseServerBoolean('  ', 'FEATURE_ENABLED', true)).toBe(true)
  })

  it('accepts strict boolean values', () => {
    expect(parseServerBoolean('true', 'FEATURE_ENABLED')).toBe(true)
    expect(parseServerBoolean(' 1 ', 'FEATURE_ENABLED')).toBe(true)
    expect(parseServerBoolean('FALSE', 'FEATURE_ENABLED')).toBe(false)
    expect(parseServerBoolean('0', 'FEATURE_ENABLED')).toBe(false)
  })

  it('rejects ambiguous values with the variable name', () => {
    expect(() => parseServerBoolean('yes', 'FEATURE_ENABLED')).toThrow(
      'FEATURE_ENABLED must be true, false, 1, or 0'
    )
  })
})

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
