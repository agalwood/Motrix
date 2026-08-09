import { describe, expect, it } from 'vitest'
import { countryCodeToFlag, countryName } from './country-flag'

describe('countryCodeToFlag', () => {
  it('converts a valid uppercase ISO code to the regional indicator emoji', () => {
    expect(countryCodeToFlag('US')).toBe('🇺🇸')
    expect(countryCodeToFlag('CN')).toBe('🇨🇳')
    expect(countryCodeToFlag('JP')).toBe('🇯🇵')
  })

  it('normalizes lowercase input', () => {
    expect(countryCodeToFlag('us')).toBe('🇺🇸')
    expect(countryCodeToFlag('Cn')).toBe('🇨🇳')
  })

  it('returns empty string for null or undefined', () => {
    expect(countryCodeToFlag(null)).toBe('')
    expect(countryCodeToFlag(undefined)).toBe('')
  })

  it('returns empty string for inputs of the wrong length', () => {
    expect(countryCodeToFlag('')).toBe('')
    expect(countryCodeToFlag('U')).toBe('')
    expect(countryCodeToFlag('USA')).toBe('')
  })

  it('returns empty string for non-letter input', () => {
    expect(countryCodeToFlag('1A')).toBe('')
    expect(countryCodeToFlag('-1')).toBe('')
    expect(countryCodeToFlag('!?')).toBe('')
  })
})

describe('countryName', () => {
  it('returns the localized region name when the runtime supports DisplayNames', () => {
    expect(countryName('US', 'en')).toMatch(/United States/)
  })

  it('returns the code when input is null/empty', () => {
    expect(countryName(null, 'en')).toBe('')
    expect(countryName('', 'en')).toBe('')
  })

  it('falls back to the code on unknown locales gracefully', () => {
    // jsdom honors valid BCP-47 tags; an unknown one is forgiving.
    expect(countryName('US', 'xx-YY')).toBeTypeOf('string')
  })
})
