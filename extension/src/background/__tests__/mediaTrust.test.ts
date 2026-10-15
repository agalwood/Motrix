import { describe, expect, it, vi } from 'vitest'
import {
  normalizeMediaReport,
  resolveStoredMedia,
} from '@/background/mediaTrust'
import type { DetectedMedia } from '@/shared/media'
import { mediaStorageKey } from '@/shared/media'

const PAGE = 'https://site.example/watch?v=1'

function item(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'direct',
    url: 'https://cdn.example/video.mp4',
    pageUrl: PAGE,
    pageTitle: 'Video',
    detectedAt: 1,
    ...over,
  }
}

describe('normalizeMediaReport', () => {
  it('accepts and canonicalizes a bounded report for the sender tab', () => {
    expect(
      normalizeMediaReport(
        {
          tabUrl: PAGE,
          items: [item({ detectedAt: Number.POSITIVE_INFINITY })],
        },
        PAGE,
        42
      )
    ).toEqual([
      {
        kind: 'direct',
        category: 'video',
        url: 'https://cdn.example/video.mp4',
        pageUrl: PAGE,
        pageTitle: 'Video',
        mimeType: 'video/mp4',
        detectedAt: 42,
      },
    ])
  })

  it('rejects reports whose claimed page differs from the browser sender tab', () => {
    expect(
      normalizeMediaReport(
        { tabUrl: 'https://attacker.example/', items: [item()] },
        PAGE
      )
    ).toEqual([])
    expect(
      normalizeMediaReport(
        {
          tabUrl: PAGE,
          items: [item({ pageUrl: 'https://attacker.example/' })],
        },
        PAGE
      )
    ).toEqual([])
  })

  it('accepts fragment-only SPA changes for the same browser document', () => {
    expect(
      normalizeMediaReport(
        {
          tabUrl: `${PAGE}#gallery`,
          items: [item({ pageUrl: `${PAGE}#gallery` })],
        },
        PAGE,
        42
      )
    ).toEqual([
      expect.objectContaining({
        url: 'https://cdn.example/video.mp4',
        pageUrl: PAGE,
      }),
    ])
  })

  it('rejects non-HTTP resources, unknown kinds, and mux items without audio', () => {
    const items = [
      item({ url: 'file:///etc/passwd' }),
      item({ kind: 'unknown' }),
      item({ kind: 'mux' }),
      item({ kind: 'mux', audioUrl: 'javascript:alert(1)' }),
    ]
    expect(normalizeMediaReport({ tabUrl: PAGE, items }, PAGE)).toEqual([])
  })

  it('only accepts page-world mux reports from the dedicated YouTube media seam', () => {
    expect(
      normalizeMediaReport(
        {
          tabUrl: PAGE,
          items: [
            item({
              kind: 'mux',
              audioUrl: 'https://victim.example/hidden.mp3',
            }),
          ],
        },
        PAGE
      )
    ).toEqual([])

    const youtubePage = 'https://www.youtube.com/watch?v=abc'
    expect(
      normalizeMediaReport(
        {
          tabUrl: youtubePage,
          items: [
            item({
              kind: 'mux',
              pageUrl: youtubePage,
              url: 'https://r1.googlevideo.com/videoplayback?id=video',
              audioUrl: 'https://r2.googlevideo.com/videoplayback?id=audio',
            }),
          ],
        },
        youtubePage
      )
    ).toEqual([
      expect.objectContaining({
        kind: 'mux',
        url: 'https://r1.googlevideo.com/videoplayback?id=video',
        audioUrl: 'https://r2.googlevideo.com/videoplayback?id=audio',
      }),
    ])
  })

  it('caps one report to 100 items and bounds page-controlled text', () => {
    const items = Array.from({ length: 150 }, (_, index) =>
      item({
        url: `https://cdn.example/${index}.mp4`,
        pageTitle: 'x'.repeat(1_000),
      })
    )
    const result = normalizeMediaReport({ tabUrl: PAGE, items }, PAGE)
    expect(result).toHaveLength(100)
    expect(result[0]?.pageTitle).toHaveLength(512)
  })

  it('caps the aggregate text budget of one report', () => {
    const token = 'x'.repeat(30_000)
    const items = Array.from({ length: 10 }, (_, index) =>
      item({
        url: `https://cdn.example/video.mp4?i=${index}&token=${token}`,
      })
    )

    expect(
      normalizeMediaReport({ tabUrl: PAGE, items }, PAGE).length
    ).toBeLessThan(items.length)
  })

  it('normalizes image metadata and derives its trusted category', () => {
    expect(
      normalizeMediaReport(
        {
          tabUrl: PAGE,
          items: [
            item({
              url: 'https://cdn.example/photo.webp',
              mimeType: 'image/webp; charset=binary',
              suggestedFilename: '../summer\u0000/photo.webp',
              sizeBytes: 4096,
              width: 1920,
              height: 1080,
              alt: '  Summer photo  ',
              evidence: [
                'img',
                'current-src',
                'srcset',
                'img',
                'network',
                'made-up',
              ],
              previewable: false,
              requestHeaders: { Authorization: 'page-controlled' },
            }),
          ],
        },
        PAGE,
        42
      )
    ).toEqual([
      {
        kind: 'direct',
        category: 'image',
        url: 'https://cdn.example/photo.webp',
        pageUrl: PAGE,
        pageTitle: 'Video',
        mimeType: 'image/webp; charset=binary',
        suggestedFilename: 'photo.webp',
        sizeBytes: 4096,
        width: 1920,
        height: 1080,
        alt: 'Summer photo',
        previewable: true,
        evidence: ['img', 'current-src', 'srcset'],
        detectedAt: 42,
      },
    ])
  })

  it('bounds numeric metadata and disables inline SVG preview', () => {
    const [svg, invalid] = normalizeMediaReport(
      {
        tabUrl: PAGE,
        items: [
          item({
            url: 'https://cdn.example/logo.svg',
            width: 128,
            height: 64,
            previewable: true,
          }),
          item({
            url: 'https://cdn.example/cover.jpg',
            width: Number.POSITIVE_INFINITY,
            height: -1,
            sizeBytes: 0,
          }),
        ],
      },
      PAGE,
      42
    )

    expect(svg).toMatchObject({
      category: 'image',
      mimeType: 'image/svg+xml',
      width: 128,
      height: 64,
      previewable: false,
    })
    expect(invalid).not.toHaveProperty('width')
    expect(invalid).not.toHaveProperty('height')
    expect(invalid).not.toHaveProperty('sizeBytes')
  })
})

describe('resolveStoredMedia', () => {
  const stored: DetectedMedia = {
    kind: 'mux',
    url: 'https://cdn.example/video.mp4',
    audioUrl: 'https://cdn.example/audio.m4a',
    pageUrl: PAGE,
    pageTitle: 'Canonical title',
    detectedAt: 42,
  }

  it('returns the background-owned record for the active tab', async () => {
    const get = vi.fn(async () => [stored])
    await expect(
      resolveStoredMedia(
        mediaStorageKey(stored),
        async () => ({ id: 7, url: PAGE }),
        { get }
      )
    ).resolves.toBe(stored)
    expect(get).toHaveBeenCalledWith(7)
  })

  it('rejects arbitrary or stale popup selections', async () => {
    await expect(
      resolveStoredMedia(
        'direct\u0000https://victim.example/private.mp4',
        async () => ({ id: 7, url: PAGE }),
        { get: async () => [stored] }
      )
    ).rejects.toThrow('Media is no longer available')

    await expect(
      resolveStoredMedia(
        mediaStorageKey(stored),
        async () => ({ id: 7, url: 'https://site.example/other' }),
        { get: async () => [stored] }
      )
    ).rejects.toThrow('Media is no longer available')
  })

  it('resolves mux variants by their full stable key', async () => {
    const english = stored
    const chinese: DetectedMedia = {
      ...stored,
      audioUrl: 'https://cdn.example/audio-zh.m4a',
    }

    await expect(
      resolveStoredMedia(
        mediaStorageKey(chinese),
        async () => ({ id: 7, url: PAGE }),
        { get: async () => [english, chinese] }
      )
    ).resolves.toBe(chinese)
  })
})
