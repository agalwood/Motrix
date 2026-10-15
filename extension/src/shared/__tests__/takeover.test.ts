import { describe, expect, it } from 'vitest'
import { isMagnetUrl, magnetDisplayName } from '@/shared/takeover'

describe('isMagnetUrl', () => {
  it('true for magnet:? links', () => {
    expect(isMagnetUrl('magnet:?xt=urn:btih:abc')).toBe(true)
  })
  it('false for http(s) and undefined', () => {
    expect(isMagnetUrl('https://example.com/a.torrent')).toBe(false)
    expect(isMagnetUrl(undefined)).toBe(false)
  })
})

describe('magnetDisplayName', () => {
  it('decodes the dn parameter', () => {
    expect(magnetDisplayName('magnet:?xt=urn:btih:abc&dn=Big+Buck+Bunny')).toBe(
      'Big Buck Bunny'
    )
  })
  it('returns undefined when dn is absent', () => {
    expect(magnetDisplayName('magnet:?xt=urn:btih:abc')).toBeUndefined()
  })
})
