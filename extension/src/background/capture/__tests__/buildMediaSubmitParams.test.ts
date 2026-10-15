import { describe, expect, it } from 'vitest'
import { buildMediaSubmitParams } from '@/background/capture/buildMediaSubmitParams'
import type { DetectedMedia } from '@/shared/media'

function media(kind: DetectedMedia['kind'], url: string): DetectedMedia {
  return {
    kind,
    url,
    pageUrl: 'https://site/p',
    pageTitle: 'My Video',
    detectedAt: 1,
  }
}

describe('buildMediaSubmitParams', () => {
  it('builds an hls selection with credentials', () => {
    const p = buildMediaSubmitParams(media('hls', 'https://h/v.m3u8'), [], {
      Referer: 'https://site/p',
    })
    expect(p.selection.kind).toBe('hls')
    if (p.selection.kind === 'hls') {
      expect(p.selection.primary.url).toBe('https://h/v.m3u8')
      expect(p.selection.primary.headers.Referer).toBe('https://site/p')
    }
    expect(p.source.pageUrl).toBe('https://site/p')
  })

  it('builds a dash selection', () => {
    const p = buildMediaSubmitParams(media('dash', 'https://h/v.mpd'), [], {})
    expect(p.selection.kind).toBe('dash')
  })

  it('builds a direct selection', () => {
    const p = buildMediaSubmitParams(media('direct', 'https://h/v.mp4'), [], {})
    expect(p.selection.kind).toBe('direct')
  })

  it('passes cookies through to primary resource', () => {
    const cookies = [
      {
        name: 'sid',
        value: 'abc',
        domain: 'h',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax' as const,
      },
    ]
    const p = buildMediaSubmitParams(
      media('hls', 'https://h/v.m3u8'),
      cookies,
      {}
    )
    if (p.selection.kind === 'hls') {
      expect(p.selection.primary.cookies).toEqual(cookies)
    }
  })

  it('sets source.pageUrl from media.pageUrl', () => {
    const p = buildMediaSubmitParams(media('direct', 'https://h/v.mp4'), [], {})
    expect(p.source.pageUrl).toBe('https://site/p')
  })

  it('uses the URL basename and output container for hls', () => {
    const p = buildMediaSubmitParams(media('hls', 'https://h/v.m3u8'), [], {})
    expect(p.meta.suggestedFilename).toBe('v.mp4')
  })

  it('uses the URL basename and output container for dash', () => {
    const p = buildMediaSubmitParams(media('dash', 'https://h/v.mpd'), [], {})
    expect(p.meta.suggestedFilename).toBe('v.mp4')
  })

  it('derives suggestedFilename from the URL basename for direct media', () => {
    const p = buildMediaSubmitParams(media('direct', 'https://h/v.mp4'), [], {})
    expect(p.meta.suggestedFilename).toBe('v.mp4')
  })

  it('prefers a Content-Disposition suggested filename over URL and alt', () => {
    const p = buildMediaSubmitParams(
      {
        ...media('direct', 'https://h/asset?id=1'),
        suggestedFilename: 'Server Hero',
        alt: 'DOM Hero',
        mimeType: 'image/avif',
      },
      [],
      {}
    )
    expect(p.meta.suggestedFilename).toBe('Server Hero.avif')
  })

  it('uses an extensionless URL basename before alt and adds the MIME extension', () => {
    const p = buildMediaSubmitParams(
      {
        ...media('direct', 'https://h/artwork?token=signed'),
        alt: 'Cover art',
        mimeType: 'image/webp; charset=binary',
      },
      [],
      {}
    )
    expect(p.meta.suggestedFilename).toBe('artwork.webp')
  })

  it('falls back to alt and then page title when the URL has no basename', () => {
    const withAlt = buildMediaSubmitParams(
      {
        ...media('direct', 'https://h/'),
        alt: 'Hero / image',
        mimeType: 'image/png',
      },
      [],
      {}
    )
    const withTitle = buildMediaSubmitParams(
      {
        ...media('direct', 'https://h/'),
        pageTitle: 'Gallery: summer',
        mimeType: 'image/jpeg',
      },
      [],
      {}
    )
    expect(withAlt.meta.suggestedFilename).toBe('Hero _ image.png')
    expect(withTitle.meta.suggestedFilename).toBe('Gallery_ summer.jpg')
  })

  it('adds correct extensions for extensionless AVIF, SVG and audio', () => {
    const avif = buildMediaSubmitParams(
      {
        ...media('direct', 'https://h/image'),
        mimeType: 'image/avif',
      },
      [],
      {}
    )
    const svg = buildMediaSubmitParams(
      {
        ...media('direct', 'https://h/vector'),
        mimeType: 'image/svg+xml',
        previewable: false,
      },
      [],
      {}
    )
    const audio = buildMediaSubmitParams(
      {
        ...media('direct', 'https://h/audio'),
        mimeType: 'audio/mp4',
      },
      [],
      {}
    )
    expect(avif.meta.suggestedFilename).toBe('image.avif')
    expect(svg.meta.suggestedFilename).toBe('vector.svg')
    expect(audio.meta.suggestedFilename).toBe('audio.m4a')
  })

  it('replaces dangerous or MIME-incompatible extensions with the trusted one', () => {
    const image = buildMediaSubmitParams(
      {
        ...media('direct', 'https://h/image'),
        suggestedFilename: 'photo.exe',
        mimeType: 'image/png',
      },
      [],
      {}
    )
    const video = buildMediaSubmitParams(
      {
        ...media('direct', 'https://h/video'),
        suggestedFilename: 'clip.jpg',
        mimeType: 'video/mp4',
      },
      [],
      {}
    )
    const doubleExtension = buildMediaSubmitParams(
      {
        ...media('direct', 'https://h/image'),
        suggestedFilename: 'photo.png.exe',
        mimeType: 'image/png',
      },
      [],
      {}
    )

    expect(image.meta.suggestedFilename).toBe('photo.png')
    expect(video.meta.suggestedFilename).toBe('clip.mp4')
    expect(doubleExtension.meta.suggestedFilename).toBe('photo.png')
  })

  it('preserves an existing extension that is compatible with the MIME', () => {
    const jpeg = buildMediaSubmitParams(
      {
        ...media('direct', 'https://h/image'),
        suggestedFilename: 'photo.jpeg',
        mimeType: 'image/jpeg',
      },
      [],
      {}
    )
    const svgz = buildMediaSubmitParams(
      {
        ...media('direct', 'https://h/vector'),
        suggestedFilename: 'vector.svgz',
        mimeType: 'image/svg+xml',
        previewable: false,
      },
      [],
      {}
    )

    expect(jpeg.meta.suggestedFilename).toBe('photo.jpeg')
    expect(svgz.meta.suggestedFilename).toBe('vector.svgz')
  })

  it('removes bidi controls before applying the trusted extension', () => {
    const p = buildMediaSubmitParams(
      {
        ...media('direct', 'https://h/image'),
        suggestedFilename: 'photo\u202Egnp.exe',
        mimeType: 'image/png',
      },
      [],
      {}
    )

    expect(p.meta.suggestedFilename).toBe('photognp.png')
  })

  it('forces the mp4 output suffix for HLS, DASH and mux selections', () => {
    for (const item of [
      { ...media('hls', 'https://h/v.m3u8'), suggestedFilename: 'hls.exe' },
      { ...media('dash', 'https://h/v.mpd'), suggestedFilename: 'dash.webp' },
      {
        ...media('mux', 'https://h/video.mp4'),
        audioUrl: 'https://h/audio.m4a',
        suggestedFilename: 'mux.mkv',
      },
    ]) {
      const p = buildMediaSubmitParams(item, [], {})
      expect(p.meta.suggestedFilename).toMatch(/\.mp4$/)
      expect(p.meta.suggestedFilename).not.toMatch(/\.(?:exe|webp|mkv)$/)
    }
  })

  it('sanitizes and bounds suggested filenames while preserving the extension', () => {
    const p = buildMediaSubmitParams(
      {
        ...media('direct', 'https://h/image'),
        suggestedFilename: `${'x'.repeat(300)}:*?`,
        mimeType: 'image/png',
      },
      [],
      {}
    )
    expect(p.meta.suggestedFilename).toHaveLength(255)
    expect(p.meta.suggestedFilename.endsWith('.png')).toBe(true)
    expect(p.meta.suggestedFilename).not.toMatch(/[:*?]/)
  })

  it('does not split a surrogate when reserving room for the MIME suffix', () => {
    const p = buildMediaSubmitParams(
      {
        ...media('direct', 'https://h/image'),
        suggestedFilename: `${'a'.repeat(250)}😀.exe`,
        mimeType: 'image/png',
      },
      [],
      {}
    )

    expect(p.meta.suggestedFilename).toBe(`${'a'.repeat(250)}.png`)
    expect(p.meta.suggestedFilename).toHaveLength(254)
  })

  it('sets qualityLabel to auto', () => {
    const p = buildMediaSubmitParams(media('direct', 'https://h/v.mp4'), [], {})
    expect(p.meta.qualityLabel).toBe('auto')
  })

  it('sets estimatedBytes when a finite positive size is known', () => {
    const p = buildMediaSubmitParams(
      { ...media('direct', 'https://h/v.mp4'), sizeBytes: 42_000.4 },
      [],
      {}
    )
    expect(p.meta.estimatedBytes).toBe(42_000)
  })

  it('omits estimatedBytes when size metadata is not usable', () => {
    const p = buildMediaSubmitParams(
      { ...media('direct', 'https://h/v.mp4'), sizeBytes: Number.NaN },
      [],
      {}
    )
    expect('estimatedBytes' in p.meta).toBe(false)
  })

  it('builds a mux selection with video and audio resources', () => {
    const videoUrl = 'https://h/video.mp4'
    const audioUrl = 'https://h/audio.m4a'
    const muxMedia: DetectedMedia = {
      kind: 'mux',
      url: videoUrl,
      audioUrl,
      pageUrl: 'https://site/p',
      pageTitle: 'My Video',
      detectedAt: 1,
    }
    const headers = { Referer: 'https://site/p' }
    const cookies = [
      {
        name: 'sid',
        value: 'abc',
        domain: 'h',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax' as const,
      },
    ]
    const audioCookies = [
      {
        name: 'audio-session',
        value: 'separate',
        domain: 'audio.h',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax' as const,
      },
    ]
    const audioHeaders = { Referer: 'https://audio-player.example/' }
    const p = buildMediaSubmitParams(muxMedia, cookies, headers, {
      cookies: audioCookies,
      headers: audioHeaders,
    })
    expect(p.selection.kind).toBe('mux')
    if (p.selection.kind === 'mux') {
      expect(p.selection.video.url).toBe(videoUrl)
      expect(p.selection.audio.url).toBe(audioUrl)
      expect(p.selection.video.headers.Referer).toBe('https://site/p')
      expect(p.selection.audio.headers.Referer).toBe(
        'https://audio-player.example/'
      )
      expect(p.selection.video.cookies).toEqual(cookies)
      expect(p.selection.audio.cookies).toEqual(audioCookies)
      expect(p.selection.container).toBe('mp4')
    }
    expect(p.meta.suggestedFilename).toBe('video.mp4')
  })

  it('never reuses primary credentials for mux audio by default', () => {
    const p = buildMediaSubmitParams(
      {
        ...media('mux', 'https://video.example/video.mp4'),
        audioUrl: 'https://audio.example/audio.m4a',
      },
      [
        {
          name: 'video-session',
          value: 'private',
          domain: 'video.example',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'lax',
        },
      ],
      { Referer: 'https://video.example/' }
    )

    expect(p.selection.kind).toBe('mux')
    if (p.selection.kind !== 'mux') return
    expect(p.selection.audio.cookies).toEqual([])
    expect(p.selection.audio.headers).toEqual({})
  })
})
