import { describe, expect, it } from 'vitest'
import { urlPatternToRegex } from '@/adapters/SiteAdapter'

describe('urlPatternToRegex', () => {
  it('matches a youtube URL via *://*.youtube.com/* pattern', () => {
    const re = urlPatternToRegex('*://*.youtube.com/*')
    expect(re.test('https://www.youtube.com/watch?v=abc')).toBe(true)
    expect(re.test('https://m.youtube.com/shorts/xyz')).toBe(true)
    expect(re.test('http://music.youtube.com/playlist?list=PL')).toBe(true)
  })

  it('rejects an unrelated URL', () => {
    const re = urlPatternToRegex('*://*.youtube.com/*')
    expect(re.test('https://example.com')).toBe(false)
    expect(re.test('https://youtube.com.evil.com/watch')).toBe(false)
  })

  it('escapes special regex chars in pattern', () => {
    const re = urlPatternToRegex('https://example.com/a+b')
    expect(re.test('https://example.com/a+b')).toBe(true)
    expect(re.test('https://example.com/aab')).toBe(false)
  })

  it('matches an exact-host pattern', () => {
    const re = urlPatternToRegex('https://www.bilibili.com/video/*')
    expect(re.test('https://www.bilibili.com/video/BV1xx411c7us')).toBe(true)
    expect(re.test('https://www.bilibili.com/live/123')).toBe(false)
  })
})
