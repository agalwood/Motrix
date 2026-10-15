import { describe, expect, it } from 'vitest'
import { isSensitiveDomain } from '@/background/capture/sensitiveDomains'

describe('isSensitiveDomain', () => {
  it('matches government and bank suffixes by host-suffix (not substring)', () => {
    expect(isSensitiveDomain('login.irs.gov')).toBe(true)
    expect(isSensitiveDomain('secure.chase.bank')).toBe(true)
  })

  it('does not false-positive on substrings like databank', () => {
    expect(isSensitiveDomain('databank.example.com')).toBe(false)
    expect(isSensitiveDomain('cdn.example.com')).toBe(false)
  })
})
