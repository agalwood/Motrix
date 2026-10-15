import { describe, expect, it } from 'vitest'
import { mapCookies } from '@/background/capture/cookies'

describe('mapCookies', () => {
  it('maps no_restriction to none and converts expirationDate seconds to ms', () => {
    const [c] = mapCookies([
      {
        name: 'sid',
        value: 'abc',
        domain: '.example.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'no_restriction',
        expirationDate: 1_700_000_000,
      },
    ])
    expect(c?.sameSite).toBe('none')
    expect(c?.expiresAt).toBe(1_700_000_000_000)
    expect(c?.httpOnly).toBe(true)
  })

  it('omits expiresAt for session cookies and maps unknown sameSite to unspecified', () => {
    const [c] = mapCookies([
      {
        name: 's',
        value: 'v',
        domain: 'h',
        path: '/',
        secure: false,
        httpOnly: false,
        sameSite: 'weird-future-value',
      },
    ])
    expect(c && 'expiresAt' in c).toBe(false)
    expect(c?.sameSite).toBe('unspecified')
  })
})
