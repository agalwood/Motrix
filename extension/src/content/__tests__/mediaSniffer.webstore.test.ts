import { describe, expect, it } from 'vitest'
import { collectFromUrls } from '@/content/mediaSniffer'

const urls = [
  { url: 'https://www.youtube.com/watch?v=x' },
  { url: 'https://r1.googlevideo.com/videoplayback' },
  { url: 'https://cdn.example.com/v.m3u8' },
]

describe('web-store exclusion', () => {
  it('keeps only non-youtube media when webStore=true', () => {
    const out = collectFromUrls(urls, {
      pageUrl: 'p',
      pageTitle: 't',
      now: 1,
      webStore: true,
    })
    expect(out.every((m) => !/youtube|googlevideo/.test(m.url))).toBe(true)
  })
  it('does not exclude in full build', () => {
    const ytMp4 = [{ url: 'https://www.youtube.com/x.mp4' }]
    const out = collectFromUrls(ytMp4, {
      pageUrl: 'p',
      pageTitle: 't',
      now: 1,
      webStore: false,
    })
    expect(out).toHaveLength(1)
  })
})
