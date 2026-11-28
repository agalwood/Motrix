import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MEDIA_SITE_SUFFIXES,
  isLikelyMediaSite,
} from './media-site-allowlist'

describe('isLikelyMediaSite', () => {
  it('matches the site itself and its subdomains', () => {
    expect(isLikelyMediaSite('https://www.youtube.com/watch?v=abc')).toBe(true)
    expect(isLikelyMediaSite('https://music.youtube.com/playlist')).toBe(true)
    expect(isLikelyMediaSite('https://youtu.be/abc')).toBe(true)
    expect(isLikelyMediaSite('https://www.bilibili.com/video/BV1')).toBe(true)
  })

  it('rejects look-alike hosts', () => {
    expect(isLikelyMediaSite('https://notyoutube.com/watch')).toBe(false)
    expect(isLikelyMediaSite('https://evil-youtube.com.evil.io/x')).toBe(false)
  })

  it('rejects non-http schemes and unparseable input', () => {
    expect(isLikelyMediaSite('magnet:?xt=urn:btih:abc')).toBe(false)
    expect(isLikelyMediaSite('ftp://youtube.com/file')).toBe(false)
    expect(isLikelyMediaSite('not a url')).toBe(false)
  })

  it('accepts operator-supplied extra suffixes', () => {
    expect(
      isLikelyMediaSite('https://videos.example.com/x', ['example.com'])
    ).toBe(true)
  })

  it('keeps the default list free of blank entries', () => {
    expect(DEFAULT_MEDIA_SITE_SUFFIXES.every((s) => s.trim().length > 0)).toBe(
      true
    )
  })
})
