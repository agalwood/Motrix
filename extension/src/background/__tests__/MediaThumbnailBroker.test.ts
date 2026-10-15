import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaStore } from '@/background/MediaStore'
import {
  MediaThumbnailBroker,
  type MediaThumbnailTabsApi,
  type MediaThumbnailWebNavigationApi,
} from '@/background/MediaThumbnailBroker'
import type { DetectedMedia } from '@/shared/media'
import { mediaStorageKey } from '@/shared/media'

const TAB_ID = 7
const PAGE_URL = 'https://page.example/gallery'
const IMAGE_URL = 'https://cdn.example/photo.webp?signature=abc'
const VALID_THUMBNAIL = 'data:image/webp;base64,AAAA'

function image(overrides: Partial<DetectedMedia> = {}): DetectedMedia {
  return {
    kind: 'direct',
    category: 'image',
    url: IMAGE_URL,
    pageUrl: PAGE_URL,
    pageTitle: 'Gallery',
    mimeType: 'image/webp',
    detectedAt: 1,
    previewable: true,
    ...overrides,
  }
}

interface Harness {
  broker: MediaThumbnailBroker
  records: DetectedMedia[]
  query: ReturnType<typeof vi.fn>
  getTab: ReturnType<typeof vi.fn>
  sendMessage: ReturnType<typeof vi.fn>
  getAllFrames: ReturnType<typeof vi.fn>
  setActive(tabId: number, url: string): void
}

function createHarness(
  options: {
    records?: DetectedMedia[]
    sendMessage?: MediaThumbnailTabsApi['sendMessage']
    frames?: Array<{ frameId: number; url: string }>
    timeoutMs?: number
    now?: () => number
  } = {}
): Harness {
  const records = options.records ?? [image()]
  let activeTabId = TAB_ID
  let activeUrl = PAGE_URL
  const query = vi.fn(async () => [
    { id: activeTabId, url: activeUrl, active: true },
  ])
  const getTab = vi.fn(async (tabId: number) => ({
    id: tabId,
    url: tabId === activeTabId ? activeUrl : 'https://other.example/',
    active: tabId === activeTabId,
  }))
  const sendMessage = vi.fn(
    options.sendMessage ?? (async () => ({ dataUrl: VALID_THUMBNAIL }))
  )
  const getAllFrames = vi.fn(async () => options.frames ?? [])
  const tabs: MediaThumbnailTabsApi = {
    query,
    get: getTab,
    sendMessage,
  }
  const webNavigation: MediaThumbnailWebNavigationApi = { getAllFrames }
  const store: Pick<MediaStore, 'get'> = {
    get: vi.fn(async () => records),
  }
  const broker = new MediaThumbnailBroker({
    store,
    tabs,
    webNavigation,
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(options.now ? { now: options.now } : {}),
  })
  return {
    broker,
    records,
    query,
    getTab,
    sendMessage,
    getAllFrames,
    setActive(tabId, url) {
      activeTabId = tabId
      activeUrl = url
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('MediaThumbnailBroker', () => {
  it('resolves a stored media key and requests a bounded top-frame thumbnail', async () => {
    const harness = createHarness()

    await expect(
      harness.broker.get(mediaStorageKey(harness.records[0] as DetectedMedia))
    ).resolves.toEqual({ dataUrl: VALID_THUMBNAIL })

    expect(harness.sendMessage).toHaveBeenCalledOnce()
    expect(harness.sendMessage).toHaveBeenCalledWith(
      TAB_ID,
      {
        kind: 'content.imageThumbnail',
        payload: { url: IMAGE_URL, maxEdge: 72 },
      },
      { frameId: 0 }
    )
    expect(harness.getTab).toHaveBeenCalledWith(TAB_ID)
  })

  it.each([
    image({ category: 'video', mimeType: 'video/mp4' }),
    image({
      url: 'https://cdn.example/vector.svg',
      mimeType: 'image/svg+xml',
      previewable: false,
    }),
  ])(
    'rejects non-previewable stored records before dispatch',
    async (record) => {
      const harness = createHarness({ records: [record] })

      await expect(
        harness.broker.get(mediaStorageKey(record))
      ).resolves.toEqual({
        dataUrl: null,
      })
      expect(harness.sendMessage).not.toHaveBeenCalled()
    }
  )

  it('also rejects an SVG record if a legacy store incorrectly marks it previewable', async () => {
    const record = image({
      url: 'https://cdn.example/vector.svg?download=1',
      mimeType: 'image/svg+xml',
      previewable: true,
    })
    const harness = createHarness({ records: [record] })

    await expect(harness.broker.get(mediaStorageKey(record))).resolves.toEqual({
      dataUrl: null,
    })
    expect(harness.sendMessage).not.toHaveBeenCalled()
  })

  it.each([
    ['plain string', VALID_THUMBNAIL],
    ['SVG MIME', { dataUrl: 'data:image/svg+xml;base64,AAAA' }],
    ['unapproved jpg alias', { dataUrl: 'data:image/jpg;base64,AAAA' }],
    ['malformed base64', { dataUrl: 'data:image/png;base64,not_+base64' }],
    [
      'oversized response',
      { dataUrl: `data:image/png;base64,${'A'.repeat(49 * 1024)}` },
    ],
    ['inherited field', Object.create({ dataUrl: VALID_THUMBNAIL }) as unknown],
  ])('rejects a forged %s response', async (_label, response) => {
    const harness = createHarness({
      sendMessage: async () => response,
    })

    await expect(
      harness.broker.get(mediaStorageKey(harness.records[0] as DetectedMedia))
    ).resolves.toEqual({ dataUrl: null })
  })

  it('isolates a hostile response getter and does not surface content errors', async () => {
    const hostile = Object.defineProperty({}, 'dataUrl', {
      enumerable: true,
      get() {
        throw new Error(`resource was ${IMAGE_URL}`)
      },
    })
    const harness = createHarness({ sendMessage: async () => hostile })

    await expect(
      harness.broker.get(mediaStorageKey(harness.records[0] as DetectedMedia))
    ).resolves.toEqual({ dataUrl: null })
  })

  it('targets only exact matching iframe URLs and tries matching frames in order', async () => {
    const frameUrl = 'https://embed.example/carousel'
    const record = image({ frameUrl })
    const harness = createHarness({
      records: [record],
      frames: [
        { frameId: 0, url: PAGE_URL },
        { frameId: 9, url: `${frameUrl}/near-match` },
        { frameId: 4, url: frameUrl },
        { frameId: 2, url: frameUrl },
      ],
      sendMessage: async (_tabId, _message, options) =>
        options?.frameId === 2
          ? { dataUrl: 'invalid' }
          : { dataUrl: VALID_THUMBNAIL },
    })

    await expect(harness.broker.get(mediaStorageKey(record))).resolves.toEqual({
      dataUrl: VALID_THUMBNAIL,
    })
    expect(harness.getAllFrames).toHaveBeenCalledWith({ tabId: TAB_ID })
    expect(harness.sendMessage.mock.calls.map((call) => call[2])).toEqual([
      { frameId: 2 },
      { frameId: 4 },
    ])
  })

  it('does not fall back to the top frame when a recorded iframe is gone', async () => {
    const record = image({ frameUrl: 'https://embed.example/missing' })
    const harness = createHarness({
      records: [record],
      frames: [{ frameId: 0, url: PAGE_URL }],
    })

    await expect(harness.broker.get(mediaStorageKey(record))).resolves.toEqual({
      dataUrl: null,
    })
    expect(harness.sendMessage).not.toHaveBeenCalled()
  })

  it('drops a thumbnail when navigation wins the response race', async () => {
    let harness: Harness
    harness = createHarness({
      sendMessage: async () => {
        harness.setActive(TAB_ID, 'https://page.example/next')
        return { dataUrl: VALID_THUMBNAIL }
      },
    })

    await expect(
      harness.broker.get(mediaStorageKey(harness.records[0] as DetectedMedia))
    ).resolves.toEqual({ dataUrl: null })
  })

  it('drops a thumbnail when the active tab changes before the reply', async () => {
    let harness: Harness
    harness = createHarness({
      sendMessage: async () => {
        harness.setActive(88, 'https://other.example/')
        return { dataUrl: VALID_THUMBNAIL }
      },
    })

    await expect(
      harness.broker.get(mediaStorageKey(harness.records[0] as DetectedMedia))
    ).resolves.toEqual({ dataUrl: null })
  })

  it('returns null after the bounded content timeout', async () => {
    vi.useFakeTimers()
    const harness = createHarness({
      timeoutMs: 1_000,
      sendMessage: () => new Promise(() => {}),
    })

    const result = harness.broker.get(
      mediaStorageKey(harness.records[0] as DetectedMedia)
    )
    await vi.advanceTimersByTimeAsync(1_001)
    await expect(result).resolves.toEqual({ dataUrl: null })
  })

  it('deduplicates in-flight loads, reuses the TTL cache, and clears per tab', async () => {
    let resolveResponse: ((value: unknown) => void) | undefined
    let now = 10
    const harness = createHarness({
      now: () => now,
      sendMessage: () =>
        new Promise((resolve) => {
          resolveResponse = resolve
        }),
    })
    const key = mediaStorageKey(harness.records[0] as DetectedMedia)

    const first = harness.broker.get(key)
    const second = harness.broker.get(key)
    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledOnce())
    resolveResponse?.({ dataUrl: VALID_THUMBNAIL })
    await expect(Promise.all([first, second])).resolves.toEqual([
      { dataUrl: VALID_THUMBNAIL },
      { dataUrl: VALID_THUMBNAIL },
    ])

    await expect(harness.broker.get(key)).resolves.toEqual({
      dataUrl: VALID_THUMBNAIL,
    })
    expect(harness.sendMessage).toHaveBeenCalledOnce()

    harness.broker.clear(TAB_ID)
    now += 1
    const afterClear = harness.broker.get(key)
    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(2))
    resolveResponse?.({ dataUrl: VALID_THUMBNAIL })
    await expect(afterClear).resolves.toEqual({ dataUrl: VALID_THUMBNAIL })
  })

  it('expires cached thumbnails after 60 seconds', async () => {
    let now = 100
    const harness = createHarness({ now: () => now })
    const key = mediaStorageKey(harness.records[0] as DetectedMedia)

    await harness.broker.get(key)
    now += 59_999
    await harness.broker.get(key)
    expect(harness.sendMessage).toHaveBeenCalledOnce()

    now += 1
    await harness.broker.get(key)
    expect(harness.sendMessage).toHaveBeenCalledTimes(2)
  })

  it('bounds the LRU to 64 thumbnails', async () => {
    const records = Array.from({ length: 65 }, (_, index) =>
      image({ url: `https://cdn.example/${index}.webp` })
    )
    const harness = createHarness({ records })

    for (const record of records) {
      await harness.broker.get(mediaStorageKey(record))
    }
    expect(harness.sendMessage).toHaveBeenCalledTimes(65)

    await harness.broker.get(mediaStorageKey(records[0] as DetectedMedia))
    expect(harness.sendMessage).toHaveBeenCalledTimes(66)
  })

  it('invalidates an outstanding request when clear is called', async () => {
    let resolveResponse: ((value: unknown) => void) | undefined
    const harness = createHarness({
      sendMessage: () =>
        new Promise((resolve) => {
          resolveResponse = resolve
        }),
    })
    const key = mediaStorageKey(harness.records[0] as DetectedMedia)

    const result = harness.broker.get(key)
    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledOnce())
    harness.broker.clear(TAB_ID)
    resolveResponse?.({ dataUrl: VALID_THUMBNAIL })

    await expect(result).resolves.toEqual({ dataUrl: null })
  })
})
