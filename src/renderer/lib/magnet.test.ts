import { describe, expect, it } from 'vitest'
import { infoHashToMagnetUri } from './magnet'

describe('infoHashToMagnetUri', () => {
  it('converts an info hash to a magnet URI', () => {
    expect(infoHashToMagnetUri('abc123')).toBe('magnet:?xt=urn:btih:abc123')
  })

  it('trims surrounding whitespace', () => {
    expect(infoHashToMagnetUri('  ABC123  ')).toBe('magnet:?xt=urn:btih:ABC123')
  })

  it('appends a URI-encoded display name when provided', () => {
    expect(infoHashToMagnetUri('abc', { name: 'My File (1080p).mkv' })).toBe(
      'magnet:?xt=urn:btih:abc&dn=My%20File%20(1080p).mkv'
    )
  })

  it('appends URI-encoded trackers when provided', () => {
    expect(
      infoHashToMagnetUri('abc', {
        trackers: [
          'udp://tracker.example.com:80/announce',
          'http://other.example.com/announce',
        ],
      })
    ).toBe(
      'magnet:?xt=urn:btih:abc' +
        '&tr=udp%3A%2F%2Ftracker.example.com%3A80%2Fannounce' +
        '&tr=http%3A%2F%2Fother.example.com%2Fannounce'
    )
  })

  it('drops blank trackers and de-duplicates repeats across tiers', () => {
    expect(
      infoHashToMagnetUri('abc', {
        trackers: [
          'udp://t1/announce',
          '',
          '  ',
          'udp://t1/announce',
          'udp://t2/announce',
        ],
      })
    ).toBe(
      'magnet:?xt=urn:btih:abc' +
        '&tr=udp%3A%2F%2Ft1%2Fannounce' +
        '&tr=udp%3A%2F%2Ft2%2Fannounce'
    )
  })

  it('combines name + trackers', () => {
    expect(
      infoHashToMagnetUri('abc', {
        name: 'demo',
        trackers: ['udp://t/announce'],
      })
    ).toBe('magnet:?xt=urn:btih:abc&dn=demo&tr=udp%3A%2F%2Ft%2Fannounce')
  })
})
