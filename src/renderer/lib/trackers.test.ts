import { describe, expect, it } from 'vitest'
import { parseTrackerInput, TRACKER_SCHEME_WHITELIST } from './trackers'

describe('TRACKER_SCHEME_WHITELIST', () => {
  it('contains exactly http/https/udp/ws/wss', () => {
    expect([...TRACKER_SCHEME_WHITELIST].sort()).toEqual([
      'http',
      'https',
      'udp',
      'ws',
      'wss',
    ])
  })
})

describe('parseTrackerInput', () => {
  it('trims whitespace per line', () => {
    const r = parseTrackerInput(
      '  http://a.example/announce  \n   udp://b.example:80   '
    )
    expect(r.valid).toEqual(['http://a.example/announce', 'udp://b.example:80'])
    expect(r.dropped).toBe(0)
  })

  it('drops empty/whitespace-only lines silently (not counted as invalid)', () => {
    const r = parseTrackerInput('http://a\n\n   \n\nhttp://b\n')
    expect(r.valid).toEqual(['http://a', 'http://b'])
    expect(r.dropped).toBe(0)
  })

  it('accepts http/https/udp/ws/wss', () => {
    const input = [
      'http://a',
      'https://b',
      'udp://c:80',
      'ws://d',
      'wss://e',
    ].join('\n')
    const r = parseTrackerInput(input)
    expect(r.valid).toHaveLength(5)
    expect(r.dropped).toBe(0)
  })

  it('rejects ftp / magnet / unknown schemes (dropped count incremented)', () => {
    const r = parseTrackerInput('ftp://a\nmagnet:?xt=foo\nhttp://b\nfoo://c')
    expect(r.valid).toEqual(['http://b'])
    expect(r.dropped).toBe(3)
  })

  it('rejects lines without scheme', () => {
    const r = parseTrackerInput('not a url\nhttp://a')
    expect(r.valid).toEqual(['http://a'])
    expect(r.dropped).toBe(1)
  })

  it('dedupes case-sensitively, first-wins (duplicates not counted as invalid)', () => {
    const r = parseTrackerInput('http://A\nhttp://a\nhttp://A')
    expect(r.valid).toEqual(['http://A', 'http://a'])
    expect(r.dropped).toBe(0)
  })

  it('preserves order of first occurrences', () => {
    const r = parseTrackerInput('http://b\nhttp://a\nhttp://c')
    expect(r.valid).toEqual(['http://b', 'http://a', 'http://c'])
  })

  it('handles mixed valid + invalid + duplicates', () => {
    const r = parseTrackerInput(
      'http://a\nftp://x\nhttp://a\n  \nhttps://b\nfoo://y\nudp://c'
    )
    expect(r.valid).toEqual(['http://a', 'https://b', 'udp://c'])
    expect(r.dropped).toBe(2)
  })
})
