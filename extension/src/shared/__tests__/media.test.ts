import { describe, expect, it } from 'vitest'
import {
  classifyMediaUrl,
  extensionForMediaMimeType,
  formatMediaBytes,
  inferMediaMimeType,
  isResolvableVideoPage,
  mediaCategory,
  mediaStorageKey,
  mediaTabStorageKey,
  readableMediaMetadata,
  shouldExcludeHost,
} from '@/shared/media'

describe('classifyMediaUrl', () => {
  it('detects HLS by extension', () => {
    expect(classifyMediaUrl('https://h/x/master.m3u8')).toBe('hls')
  })
  it('detects DASH by extension', () => {
    expect(classifyMediaUrl('https://h/x/manifest.mpd')).toBe('dash')
  })
  it('detects HLS by content-type when extension is absent', () => {
    expect(
      classifyMediaUrl('https://h/x?id=1', 'application/vnd.apple.mpegurl')
    ).toBe('hls')
    expect(classifyMediaUrl('https://h/x?id=2', 'audio/x-mpegurl')).toBe('hls')
  })
  it('detects direct mp4', () => {
    expect(classifyMediaUrl('https://h/x/movie.mp4')).toBe('direct')
  })
  it('detects common audio and image extensions as direct resources', () => {
    expect(classifyMediaUrl('https://h/x/podcast.MP3?token=1')).toBe('direct')
    expect(classifyMediaUrl('https://h/x/cover.avif#preview')).toBe('direct')
    expect(classifyMediaUrl('https://h/x/photo.jfif')).toBe('direct')
  })
  it('detects extensionless audio and image responses by MIME', () => {
    expect(classifyMediaUrl('https://h/audio?id=1', 'audio/flac')).toBe(
      'direct'
    )
    expect(classifyMediaUrl('https://h/image?id=1', 'image/webp')).toBe(
      'direct'
    )
  })
  it('returns null for non-media', () => {
    expect(classifyMediaUrl('https://h/x/page.html')).toBeNull()
  })
  it('classifies SVG/SVGZ as downloadable images', () => {
    expect(classifyMediaUrl('https://h/x/icon.svg')).toBe('direct')
    expect(classifyMediaUrl('https://h/x/icon.svgz')).toBe('direct')
    expect(classifyMediaUrl('https://h/x/render?id=1', 'image/svg+xml')).toBe(
      'direct'
    )
  })
})

describe('inferMediaMimeType', () => {
  it('maps common audio and image extensions to filterable MIME values', () => {
    expect(inferMediaMimeType('https://h/track.m4a')).toBe('audio/mp4')
    expect(inferMediaMimeType('https://h/photo.JPEG?size=2x')).toBe(
      'image/jpeg'
    )
  })

  it('prefers useful response MIME metadata over the extension', () => {
    expect(
      inferMediaMimeType('https://h/download.bin', 'audio/webm; codecs="opus"')
    ).toBe('audio/webm; codecs="opus"')
  })

  it('falls back to the extension for a generic response MIME', () => {
    expect(
      inferMediaMimeType('https://h/artwork.png', 'application/octet-stream')
    ).toBe('image/png')
  })

  it('maps SVG/SVGZ to image/svg+xml', () => {
    expect(inferMediaMimeType('https://h/icon.svg')).toBe('image/svg+xml')
    expect(inferMediaMimeType('https://h/icon.svgz')).toBe('image/svg+xml')
  })
})

describe('media metadata helpers', () => {
  it('maps parameterized MIME values to canonical extensions', () => {
    expect(extensionForMediaMimeType('image/jpeg; charset=binary')).toBe('jpg')
    expect(extensionForMediaMimeType('image/svg+xml')).toBe('svg')
    expect(extensionForMediaMimeType('image/avif-sequence')).toBe('avif')
    expect(extensionForMediaMimeType('audio/mp4')).toBe('m4a')
    expect(extensionForMediaMimeType('application/vnd.apple.mpegurl')).toBe(
      'm3u8'
    )
    expect(extensionForMediaMimeType('application/octet-stream')).toBeNull()
  })

  it('uses explicit category, then infers category from MIME and URL', () => {
    expect(
      mediaCategory({
        kind: 'direct',
        url: 'https://h/opaque',
        mimeType: 'image/avif',
      })
    ).toBe('image')
    expect(mediaCategory({ kind: 'direct', url: 'https://h/track.flac' })).toBe(
      'audio'
    )
    expect(
      mediaCategory({
        kind: 'direct',
        url: 'https://h/opaque',
        category: 'image',
      })
    ).toBe('image')
    expect(mediaCategory({ kind: 'hls', url: 'https://h/live.m3u8' })).toBe(
      'video'
    )
  })

  it('keeps signed queries in storage keys and separates mux audio tracks', () => {
    expect(
      mediaStorageKey({
        kind: 'direct',
        url: 'https://cdn/image?id=1&signature=abc',
      })
    ).toBe('https://cdn/image?id=1&signature=abc')
    expect(
      mediaStorageKey({
        kind: 'mux',
        url: 'https://cdn/video?id=1',
        audioUrl: 'https://cdn/audio?id=2',
      })
    ).toBe('https://cdn/video?id=1\u0000https://cdn/audio?id=2')
    expect(mediaTabStorageKey(17)).toBe('media:17')
  })

  it('formats compact resource metadata', () => {
    expect(formatMediaBytes(438_272)).toBe('428 KB')
    expect(
      readableMediaMetadata({
        kind: 'direct',
        url: 'https://h/image',
        pageUrl: 'https://h',
        pageTitle: 'Photo',
        detectedAt: 1,
        mimeType: 'image/webp',
        width: 1920,
        height: 1080,
        sizeBytes: 438_272,
      })
    ).toBe('WEBP · 1920×1080 · 428 KB')
  })
})

describe('isResolvableVideoPage', () => {
  describe('bilibili — always resolvable regardless of webStore flag', () => {
    it('bilibili.com is resolvable in full build', () => {
      const r = isResolvableVideoPage(
        'https://www.bilibili.com/video/BV1xx411c7mD',
        false
      )
      expect(r).toEqual({ resolvable: true, site: 'bilibili' })
    })
    it('bilibili.com is resolvable in webstore build', () => {
      const r = isResolvableVideoPage(
        'https://www.bilibili.com/video/BV1xx411c7mD',
        true
      )
      expect(r).toEqual({ resolvable: true, site: 'bilibili' })
    })
    it('bare bilibili.com host is resolvable', () => {
      const r = isResolvableVideoPage(
        'https://bilibili.com/video/BV1xx411c7mD',
        false
      )
      expect(r).toEqual({ resolvable: true, site: 'bilibili' })
    })
    it('b23.tv short-link is resolvable in full build', () => {
      const r = isResolvableVideoPage('https://b23.tv/abc123', false)
      expect(r).toEqual({ resolvable: true, site: 'bilibili' })
    })
    it('b23.tv short-link is resolvable in webstore build', () => {
      const r = isResolvableVideoPage('https://b23.tv/abc123', true)
      expect(r).toEqual({ resolvable: true, site: 'bilibili' })
    })
  })

  describe('youtube — resolvable only in full build (SP-1 web-store gate)', () => {
    it('youtube.com is resolvable in full build', () => {
      const r = isResolvableVideoPage(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        false
      )
      expect(r).toEqual({ resolvable: true, site: 'youtube' })
    })
    it('youtube.com is NOT resolvable in webstore build', () => {
      const r = isResolvableVideoPage(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        true
      )
      expect(r).toEqual({ resolvable: false })
    })
    it('youtu.be is resolvable in full build', () => {
      const r = isResolvableVideoPage('https://youtu.be/dQw4w9WgXcQ', false)
      expect(r).toEqual({ resolvable: true, site: 'youtube' })
    })
    it('youtu.be is NOT resolvable in webstore build', () => {
      const r = isResolvableVideoPage('https://youtu.be/dQw4w9WgXcQ', true)
      expect(r).toEqual({ resolvable: false })
    })
    it('youtube-nocookie.com is resolvable in full build', () => {
      const r = isResolvableVideoPage(
        'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
        false
      )
      expect(r).toEqual({ resolvable: true, site: 'youtube' })
    })
    it('youtube-nocookie.com is NOT resolvable in webstore build', () => {
      const r = isResolvableVideoPage(
        'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
        true
      )
      expect(r).toEqual({ resolvable: false })
    })
  })

  describe('non-video pages → not resolvable', () => {
    it('returns false for unrelated host', () => {
      const r = isResolvableVideoPage('https://example.com/page', false)
      expect(r).toEqual({ resolvable: false })
    })
    it('returns false for unrelated host in webstore build', () => {
      const r = isResolvableVideoPage('https://vimeo.com/video/123', true)
      expect(r).toEqual({ resolvable: false })
    })
  })

  describe('malformed URL → not resolvable', () => {
    it('returns false for a totally invalid URL', () => {
      const r = isResolvableVideoPage('not-a-url', false)
      expect(r).toEqual({ resolvable: false })
    })
    it('returns false for an empty string', () => {
      const r = isResolvableVideoPage('', false)
      expect(r).toEqual({ resolvable: false })
    })
  })
})

describe('shouldExcludeHost', () => {
  it('excludes youtube + googlevideo in web-store build', () => {
    expect(shouldExcludeHost('www.youtube.com', true)).toBe(true)
    expect(shouldExcludeHost('r3---sn-x.googlevideo.com', true)).toBe(true)
  })
  it('allows youtube in full build', () => {
    expect(shouldExcludeHost('www.youtube.com', false)).toBe(false)
  })
  it('allows unrelated hosts in both builds', () => {
    expect(shouldExcludeHost('cdn.example.com', true)).toBe(false)
  })
})
