import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_IMAGE_MEDIA_PER_TAB,
  MAX_MEDIA_PER_TAB,
  MAX_MEDIA_STORAGE_BYTES_PER_TAB,
  MediaStore,
} from '@/background/MediaStore'
import type { DetectedMedia } from '@/shared/media'

function media(
  url: string,
  overrides: Partial<DetectedMedia> = {}
): DetectedMedia {
  return {
    kind: 'hls',
    url,
    pageUrl: 'https://p',
    pageTitle: 'T',
    detectedAt: 1,
    ...overrides,
  }
}

function installSessionStorage(session: unknown): void {
  const globals = globalThis as unknown as {
    browser: unknown
    chrome: unknown
  }
  Object.assign(globals.browser as object, { storage: { session } })
  globals.chrome = { storage: { session } }
}

describe('MediaStore', () => {
  let store: MediaStore
  let mem: Map<string, unknown>
  beforeEach(() => {
    mem = new Map<string, unknown>()
    installSessionStorage({
      get: async (k: string) => ({ [k]: mem.get(k) }),
      set: async (o: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(o)) mem.set(k, v)
      },
      remove: async (k: string) => void mem.delete(k),
    })
    store = new MediaStore()
  })

  it('dedups by url within a tab', async () => {
    await store.add(7, [media('https://h/a.m3u8'), media('https://h/a.m3u8')])
    await store.add(7, [media('https://h/b.m3u8')])
    const got = await store.get(7)
    expect(got.map((m) => m.url)).toEqual([
      'https://h/a.m3u8',
      'https://h/b.m3u8',
    ])
  })

  it('refreshes metadata for a URL observed again during rescan', async () => {
    await store.add(7, [media('https://h/a.m3u8')])
    await store.add(7, [
      {
        ...media('https://h/a.m3u8'),
        pageTitle: 'Updated title',
        detectedAt: 2,
      },
    ])

    expect(await store.get(7)).toMatchObject([
      { pageTitle: 'Updated title', detectedAt: 2 },
    ])
  })

  it('deterministically merges rich fields from duplicate capture sources', async () => {
    const url = 'https://cdn.example/photo?id=7&signature=abc'
    await store.add(7, [
      media(url, {
        kind: 'direct',
        category: 'image',
        mimeType: 'image/webp',
        suggestedFilename: 'hero.webp',
        width: 1920,
        height: 1080,
        alt: 'Hero image',
        previewable: true,
        requestHeaders: { Referer: 'https://p' },
        evidence: ['dom-img'],
        detectedAt: 10,
      }),
    ])
    await store.add(7, [
      media(url, {
        kind: 'direct',
        category: 'image',
        pageTitle: '',
        sizeBytes: 456_789,
        requestHeaders: { Cookie: 'session=1' },
        evidence: ['network', 'dom-img'],
        detectedAt: 20,
      }),
    ])

    expect(await store.get(7)).toEqual([
      expect.objectContaining({
        url,
        pageTitle: 'T',
        mimeType: 'image/webp',
        suggestedFilename: 'hero.webp',
        sizeBytes: 456_789,
        width: 1920,
        height: 1080,
        alt: 'Hero image',
        previewable: true,
        evidence: ['dom-img', 'network'],
        detectedAt: 20,
      }),
    ])
    expect((await store.get(7))[0]).not.toHaveProperty('requestHeaders')
  })

  it('uses a stable rich observation when timestamps are equal', async () => {
    const url = 'https://cdn.example/equal-time.jpg'
    const sparse = media(url, {
      kind: 'direct',
      category: 'image',
      detectedAt: 5,
    })
    const rich = media(url, {
      kind: 'direct',
      category: 'image',
      mimeType: 'image/jpeg',
      suggestedFilename: 'equal-time.jpg',
      detectedAt: 5,
    })

    await store.add(1, [sparse, rich])
    await store.add(2, [rich, sparse])

    expect(await store.get(1)).toEqual(await store.get(2))
    expect(await store.get(1)).toMatchObject([
      {
        mimeType: 'image/jpeg',
        suggestedFilename: 'equal-time.jpg',
      },
    ])
  })

  it('bounds serialized media storage and strips credential fields', async () => {
    await store.add(
      7,
      Array.from({ length: 120 }, (_, index) =>
        media(`https://cdn.example/${index}.jpg`, {
          kind: 'direct',
          category: 'image',
          alt: `${index}-${'x'.repeat(5_000)}`,
          requestHeaders: { Cookie: `secret-${index}` },
          detectedAt: index + 1,
        })
      )
    )

    const stored = await store.get(7)
    expect(
      new TextEncoder().encode(JSON.stringify(stored)).byteLength
    ).toBeLessThanOrEqual(MAX_MEDIA_STORAGE_BYTES_PER_TAB)
    expect(stored.length).toBeLessThan(120)
    expect(stored.every((item) => !('requestHeaders' in item))).toBe(true)
  })

  it('does not downgrade header-backed filename or MIME metadata', async () => {
    const url = 'https://cdn.example/download?id=42'
    await store.add(7, [
      media(url, {
        kind: 'direct',
        category: 'image',
        suggestedFilename: 'original-photo.avif',
        mimeType: 'image/avif',
        evidence: ['network', 'content-disposition', 'content-type'],
        detectedAt: 1,
      }),
    ])
    await store.add(7, [
      media(url, {
        kind: 'direct',
        category: 'image',
        suggestedFilename: 'page-title.png',
        mimeType: 'image/*',
        evidence: ['img'],
        detectedAt: 100,
      }),
    ])

    expect(await store.get(7)).toMatchObject([
      {
        suggestedFilename: 'original-photo.avif',
        mimeType: 'image/avif',
        detectedAt: 100,
      },
    ])
  })

  it('keeps signed query URLs as distinct storage keys', async () => {
    await store.add(7, [
      media('https://cdn.example/photo.jpg?signature=alpha', {
        kind: 'direct',
        category: 'image',
      }),
      media('https://cdn.example/photo.jpg?signature=beta', {
        kind: 'direct',
        category: 'image',
      }),
    ])

    expect((await store.get(7)).map((item) => item.url)).toEqual([
      'https://cdn.example/photo.jpg?signature=alpha',
      'https://cdn.example/photo.jpg?signature=beta',
    ])
  })

  it('does not merge mux variants with different audio tracks', async () => {
    const url = 'https://cdn.example/video-only.mp4?token=stable'
    await store.add(7, [
      media(url, {
        kind: 'mux',
        audioUrl: 'https://cdn.example/audio-en.m4a',
      }),
      media(url, {
        kind: 'mux',
        audioUrl: 'https://cdn.example/audio-zh.m4a',
      }),
    ])

    expect((await store.get(7)).map((item) => item.audioUrl)).toEqual([
      'https://cdn.example/audio-en.m4a',
      'https://cdn.example/audio-zh.m4a',
    ])
  })

  it('clear empties a tab', async () => {
    await store.add(7, [media('https://h/a.m3u8')])
    await store.clear(7)
    expect(await store.get(7)).toEqual([])
  })

  it('retains current-page media and removes results from prior navigation', async () => {
    await store.add(7, [
      media('https://h/a.m3u8'),
      {
        ...media('https://h/b.m3u8'),
        pageUrl: 'https://other-page',
      },
    ])

    await store.retainPage(7, 'https://p')

    expect((await store.get(7)).map((item) => item.url)).toEqual([
      'https://h/a.m3u8',
    ])
  })

  it('atomically retains the page and adds its newly detected media', async () => {
    await store.add(7, [
      { ...media('https://h/old.m3u8'), pageUrl: 'https://old-page' },
    ])

    await store.retainPage(7, 'https://new-page')
    await store.addForPage(7, 'https://new-page', [
      {
        ...media('https://h/new.mp4'),
        kind: 'direct',
        pageUrl: 'https://new-page',
      },
    ])

    expect(await store.get(7)).toEqual([
      expect.objectContaining({
        url: 'https://h/new.mp4',
        pageUrl: 'https://new-page',
      }),
    ])
  })

  it('does not let an item for a different page enter addForPage', async () => {
    await store.addForPage(7, 'https://current-page', [
      { ...media('https://h/stale.m3u8'), pageUrl: 'https://old-page' },
    ])

    expect(await store.get(7)).toEqual([])
  })

  it('rejects a late old-document write once navigation is observed', async () => {
    await store.retainPage(7, 'https://old-page')
    const staleWrite = store.addForPage(7, 'https://old-page', [
      { ...media('https://h/stale.m3u8'), pageUrl: 'https://old-page' },
    ])
    const navigation = store.retainPage(7, 'https://new-page')

    await Promise.all([staleWrite, navigation])
    expect(await store.get(7)).toEqual([])
  })

  it('serializes concurrent additions for the same tab', async () => {
    let releaseFirstWrite: (() => void) | undefined
    let firstWriteStarted: (() => void) | undefined
    const firstWrite = new Promise<void>((resolve) => {
      firstWriteStarted = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    let writes = 0
    const get = vi.fn(async (key: string) => ({ [key]: mem.get(key) }))
    installSessionStorage({
      get,
      set: async (value: Record<string, unknown>) => {
        writes += 1
        if (writes === 1) {
          firstWriteStarted?.()
          await release
        }
        for (const [key, item] of Object.entries(value)) mem.set(key, item)
      },
      remove: async (key: string) => void mem.delete(key),
    })
    store = new MediaStore()

    const first = store.add(7, [media('https://h/a.m3u8')])
    await firstWrite
    const second = store.add(7, [media('https://h/b.m3u8')])
    await Promise.resolve()
    expect(get).toHaveBeenCalledTimes(1)

    releaseFirstWrite?.()
    await Promise.all([first, second])

    expect((await store.get(7)).map((item) => item.url)).toEqual([
      'https://h/a.m3u8',
      'https://h/b.m3u8',
    ])
  })

  it('does not let retainPage overwrite a concurrent add', async () => {
    await store.add(7, [
      { ...media('https://h/old.m3u8'), pageUrl: 'https://old-page' },
    ])

    await Promise.all([
      store.retainPage(7, 'https://p'),
      store.add(7, [media('https://h/new.m3u8')]),
    ])

    expect((await store.get(7)).map((item) => item.url)).toEqual([
      'https://h/new.m3u8',
    ])
  })

  it('bounds page-controlled media growth and retains the newest items', async () => {
    const items = Array.from({ length: MAX_MEDIA_PER_TAB + 25 }, (_, index) =>
      media(`https://h/${index}.mp4`)
    )

    await store.add(1, items)

    const result = await store.get(1)
    expect(result).toHaveLength(MAX_MEDIA_PER_TAB)
    expect(result[0]?.url).toBe('https://h/25.mp4')
    expect(result.at(-1)?.url).toBe(`https://h/${MAX_MEDIA_PER_TAB + 24}.mp4`)
  })

  it('caps images independently while retaining the newest image observations', async () => {
    const images = Array.from(
      { length: MAX_IMAGE_MEDIA_PER_TAB + 25 },
      (_, index) =>
        media(`https://images.example/${index}.webp`, {
          kind: 'direct',
        })
    )

    await store.add(1, images)

    const result = await store.get(1)
    expect(result).toHaveLength(MAX_IMAGE_MEDIA_PER_TAB)
    expect(result[0]?.url).toBe('https://images.example/25.webp')
    expect(result.at(-1)?.url).toBe(
      `https://images.example/${MAX_IMAGE_MEDIA_PER_TAB + 24}.webp`
    )
  })

  it('retains an older large image when later icon noise exceeds the quota', async () => {
    const hero = media('https://images.example/hero.webp', {
      kind: 'direct',
      category: 'image',
      mimeType: 'image/webp',
      width: 3840,
      height: 2160,
      sizeBytes: 4_000_000,
      evidence: ['img'],
      detectedAt: 1,
    })
    const icons = Array.from(
      { length: MAX_IMAGE_MEDIA_PER_TAB + 30 },
      (_, index) =>
        media(`https://images.example/icon-${index}.png`, {
          kind: 'direct',
          category: 'image',
          mimeType: 'image/png',
          width: 24,
          height: 24,
          sizeBytes: 900,
          evidence: ['network'],
          detectedAt: index + 2,
        })
    )

    await store.add(1, [hero, ...icons])

    const result = await store.get(1)
    expect(result).toHaveLength(MAX_IMAGE_MEDIA_PER_TAB)
    expect(result).toContainEqual(hero)
    expect(result.some((item) => item.url.endsWith('/icon-0.png'))).toBe(false)
    expect(result.some((item) => item.url.endsWith('/icon-149.png'))).toBe(true)
  })

  it('never lets an image flood evict streams, video, or audio', async () => {
    const protectedMedia = [
      media('https://media.example/master.m3u8'),
      media('https://media.example/manifest.mpd', { kind: 'dash' }),
      media('https://media.example/movie.mp4', {
        kind: 'direct',
        category: 'video',
        mimeType: 'video/mp4',
      }),
      media('https://media.example/song.flac', {
        kind: 'direct',
        category: 'audio',
        mimeType: 'audio/flac',
      }),
    ]
    const images = Array.from({ length: MAX_MEDIA_PER_TAB * 2 }, (_, index) =>
      media(`https://images.example/${index}.jpg`, {
        kind: 'direct',
        category: 'image',
        mimeType: 'image/jpeg',
      })
    )

    await store.add(1, [...protectedMedia, ...images])

    const result = await store.get(1)
    expect(result.length).toBeLessThanOrEqual(MAX_MEDIA_PER_TAB)
    expect(result.filter((item) => item.category === 'image')).toHaveLength(
      MAX_IMAGE_MEDIA_PER_TAB
    )
    expect(result).toEqual(expect.arrayContaining(protectedMedia))
  })

  it('evicts images before non-images when the overall quota is full', async () => {
    const videos = Array.from({ length: MAX_MEDIA_PER_TAB }, (_, index) =>
      media(`https://media.example/${index}.mp4`, {
        kind: 'direct',
        category: 'video',
        mimeType: 'video/mp4',
      })
    )
    const images = Array.from({ length: 20 }, (_, index) =>
      media(`https://images.example/${index}.png`, {
        kind: 'direct',
        category: 'image',
        mimeType: 'image/png',
      })
    )

    await store.add(1, [...images, ...videos])

    const result = await store.get(1)
    expect(result).toHaveLength(MAX_MEDIA_PER_TAB)
    expect(result.every((item) => item.category !== 'image')).toBe(true)
    expect(result.map((item) => item.url)).toEqual(
      videos.map((item) => item.url)
    )
  })

  it('prefers Firefox Promise storage when callback-only chrome also exists', async () => {
    const firefoxMem = new Map<string, unknown>()
    const browserGet = vi.fn(async (key: string) => ({
      [key]: firefoxMem.get(key),
    }))
    const browserSet = vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, item] of Object.entries(items)) firefoxMem.set(key, item)
    })
    const browserRemove = vi.fn(async (key: string) => {
      firefoxMem.delete(key)
    })
    const chromeGet = vi.fn(
      (_key: string, callback: (items: Record<string, unknown>) => void) => {
        callback({})
      }
    )
    const chromeSet = vi.fn(
      (_items: Record<string, unknown>, callback?: () => void) => callback?.()
    )
    const chromeRemove = vi.fn((_key: string, callback?: () => void) =>
      callback?.()
    )
    const globals = globalThis as unknown as {
      browser: unknown
      chrome: unknown
    }
    Object.assign(globals.browser as object, {
      storage: {
        session: {
          get: browserGet,
          set: browserSet,
          remove: browserRemove,
        },
      },
    })
    globals.chrome = {
      storage: {
        session: {
          get: chromeGet,
          set: chromeSet,
          remove: chromeRemove,
        },
      },
    }
    store = new MediaStore()

    await store.add(7, [
      media('https://h/current.mp4'),
      { ...media('https://h/old.mp4'), pageUrl: 'https://old-page' },
    ])
    await store.retainPage(7, 'https://p')
    expect((await store.get(7)).map((item) => item.url)).toEqual([
      'https://h/current.mp4',
    ])

    await store.retainPage(7, 'https://new-page')
    await store.addForPage(7, 'https://new-page', [
      {
        ...media('https://h/new.mp4'),
        kind: 'direct',
        pageUrl: 'https://new-page',
      },
    ])
    expect(await store.get(7)).toEqual([
      expect.objectContaining({
        url: 'https://h/new.mp4',
        pageUrl: 'https://new-page',
      }),
    ])

    await store.clear(7)
    expect(await store.get(7)).toEqual([])
    expect(browserGet).toHaveBeenCalled()
    expect(browserSet).toHaveBeenCalled()
    expect(browserRemove).toHaveBeenCalled()
    expect(chromeGet).not.toHaveBeenCalled()
    expect(chromeSet).not.toHaveBeenCalled()
    expect(chromeRemove).not.toHaveBeenCalled()
  })
})
