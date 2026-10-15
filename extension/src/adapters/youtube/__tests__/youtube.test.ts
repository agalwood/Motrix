import { describe, expect, it } from 'vitest'
import { youtubeAdapter } from '@/adapters/youtube/index'
import { extractVideoId, probeYouTubeUrl } from '@/adapters/youtube/probe'

describe('YouTube probe', () => {
  it('matches www.youtube.com/watch', () => {
    expect(probeYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      true
    )
  })

  it('matches youtu.be short links', () => {
    expect(probeYouTubeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true)
  })

  it('matches /shorts/', () => {
    expect(probeYouTubeUrl('https://www.youtube.com/shorts/abc12345678')).toBe(
      true
    )
  })

  it('matches /playlist', () => {
    expect(
      probeYouTubeUrl('https://www.youtube.com/playlist?list=PLabc12345')
    ).toBe(true)
  })

  it('matches m.youtube.com and music.youtube.com', () => {
    expect(probeYouTubeUrl('https://m.youtube.com/watch?v=abcdefghijk')).toBe(
      true
    )
    expect(
      probeYouTubeUrl('https://music.youtube.com/watch?v=abcdefghijk')
    ).toBe(true)
  })

  it('rejects unrelated URLs', () => {
    expect(probeYouTubeUrl('https://example.com/x')).toBe(false)
    expect(probeYouTubeUrl('https://youtube.com.evil.com/watch?v=x')).toBe(
      false
    )
  })
})

describe('extractVideoId', () => {
  it('parses /watch?v=', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ'
    )
  })

  it('parses /shorts/', () => {
    expect(extractVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ'
    )
  })

  it('parses youtu.be/', () => {
    expect(extractVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })

  it('returns null for non-video URLs', () => {
    expect(extractVideoId('https://www.youtube.com/')).toBeNull()
  })
})

describe('youtubeAdapter', () => {
  it('probe returns handled:true with high confidence', () => {
    const r = youtubeAdapter.probe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    )
    expect(r.handled).toBe(true)
    expect(r.confidence).toBe('high')
  })

  it('probe returns handled:false for non-YouTube', () => {
    const r = youtubeAdapter.probe('https://example.com')
    expect(r.handled).toBe(false)
  })

  it('resolve returns spec-compliant placeholder', async () => {
    const r = await youtubeAdapter.resolve(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      { maxQuality: '1080p' }
    )
    expect(r.selections).toHaveLength(1)
    expect(r.extractedBy.adapterId).toBe('youtube')
    expect(r.meta.title).toContain('placeholder')
    expect(r.selections[0]?.kind).toBe('direct')
    if (r.selections[0]?.kind === 'direct') {
      expect(r.selections[0].quality).toBe('1080p')
    }
  })

  it('exposes urlPatterns + version metadata', () => {
    expect(youtubeAdapter.id).toBe('youtube')
    expect(youtubeAdapter.version).toBe('0.1.0')
    expect(youtubeAdapter.urlPatterns).toContain('*://*.youtube.com/*')
    expect(youtubeAdapter.urlPatterns).toContain('*://youtu.be/*')
  })
})
