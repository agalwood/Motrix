import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/background/MessageBus', () => ({ send: vi.fn() }))

import * as MessageBus from '@/background/MessageBus'
import {
  pageMediaSubmissionsSessionKey,
  usePageMedia,
} from '@/popup/usePageMedia'
import { mediaStorageKey } from '@/shared/media'

const send = vi.mocked(MessageBus.send)

// chrome.tabs.query is stubbed in setup.ts with a default of [] (no active tab).
// Tests that need a specific tab override it per-test.
const tabsQuery = vi.mocked(
  (globalThis as unknown as { chrome: { tabs: { query: typeof vi.fn } } })
    .chrome.tabs.query
)
type StorageChangedListener = (
  changes: Record<string, { newValue?: unknown }>,
  areaName: string
) => void
type StorageOnChanged = {
  addListener(listener: StorageChangedListener): void
  removeListener(listener: StorageChangedListener): void
}
const storageOnChanged = (
  globalThis as unknown as {
    chrome: {
      storage: {
        onChanged: StorageOnChanged
      }
    }
  }
).chrome.storage.onChanged
const storageChangedAdd = vi.mocked(storageOnChanged.addListener)
const storageChangedRemove = vi.mocked(storageOnChanged.removeListener)

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('usePageMedia', () => {
  beforeEach(() => {
    // Default: no active tab (resolvableSite should stay null)
    tabsQuery.mockResolvedValue([])
  })

  it('scan populates media + selectionKinds', async () => {
    send.mockResolvedValueOnce({
      media: [
        {
          kind: 'hls',
          url: 'https://h/v.m3u8',
          pageUrl: 'p',
          pageTitle: 't',
          detectedAt: 1,
        },
      ],
      selectionKinds: ['direct', 'hls', 'dash', 'mux'],
    })
    const { result } = renderHook(() => usePageMedia())
    await act(async () => {
      await result.current.scan()
    })
    await waitFor(() => expect(result.current.media).toHaveLength(1))
    expect(result.current.selectionKinds).toContain('hls')
  })

  it('applies live session media updates for the active tab and cleans up the listener', async () => {
    tabsQuery.mockResolvedValue([
      {
        id: 17,
        url: 'https://www.bilibili.com/video/BV1xx411c7mD',
      },
    ])
    const image = {
      kind: 'direct' as const,
      url: 'https://cdn.example/hero.webp',
      pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
      pageTitle: 'Hero',
      category: 'image' as const,
      detectedAt: 2,
    }
    const { result, unmount } = renderHook(() => usePageMedia())

    await waitFor(() => expect(result.current.resolvableSite).toBe('bilibili'))
    const listener = storageChangedAdd.mock.calls[0]?.[0]
    if (!listener) throw new Error('storage change listener was not installed')

    act(() => {
      listener({ 'media:17': { newValue: [image] } }, 'session')
    })
    expect(result.current.media).toEqual([image])
    expect(send).not.toHaveBeenCalledWith('bg.scanActiveTab', undefined)

    act(() => {
      listener({ 'media:17': { newValue: [] } }, 'local')
      listener({ 'media:18': { newValue: [] } }, 'session')
    })
    expect(result.current.media).toEqual([image])

    act(() => {
      listener({ 'media:17': { newValue: undefined } }, 'session')
    })
    expect(result.current.media).toEqual([])

    unmount()
    expect(storageChangedRemove).toHaveBeenCalledWith(listener)
  })

  it('does not let an older scan response overwrite a newer live storage update', async () => {
    tabsQuery.mockResolvedValue([
      {
        id: 23,
        url: 'https://www.bilibili.com/video/BV1xx411c7mD',
      },
    ])
    const staleScan = deferred<{
      media: Array<{
        kind: 'direct'
        url: string
        pageUrl: string
        pageTitle: string
        detectedAt: number
      }>
      selectionKinds: string[]
    }>()
    send.mockImplementationOnce(() => staleScan.promise)
    const liveImage = {
      kind: 'direct' as const,
      url: 'https://cdn.example/newer.webp',
      pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
      pageTitle: 'Newer image',
      category: 'image' as const,
      detectedAt: 20,
    }
    const staleVideo = {
      kind: 'direct' as const,
      url: 'https://cdn.example/older.mp4',
      pageUrl: liveImage.pageUrl,
      pageTitle: 'Older video',
      detectedAt: 10,
    }
    const { result } = renderHook(() => usePageMedia())

    await waitFor(() => expect(result.current.resolvableSite).toBe('bilibili'))
    const listener = storageChangedAdd.mock.calls[0]?.[0]
    if (!listener) throw new Error('storage change listener was not installed')
    let scanPromise!: Promise<void>
    act(() => {
      scanPromise = result.current.scan()
    })
    act(() => {
      listener({ 'media:23': { newValue: [liveImage] } }, 'session')
    })

    await act(async () => {
      staleScan.resolve({
        media: [staleVideo],
        selectionKinds: ['direct', 'mux'],
      })
      await scanPromise
    })

    expect(result.current.media).toEqual([liveImage])
    expect(result.current.selectionKinds).toEqual(['direct', 'mux'])
    expect(result.current.scanning).toBe(false)
  })

  it('still works when a preview surface omits storage.onChanged', async () => {
    send.mockResolvedValueOnce({ media: [], selectionKinds: ['direct'] })
    const globals = globalThis as unknown as {
      browser: { storage: { onChanged?: typeof storageOnChanged } }
      chrome: { storage: { onChanged?: typeof storageOnChanged } }
    }
    const browserOnChanged = globals.browser.storage.onChanged
    const chromeOnChanged = globals.chrome.storage.onChanged
    delete globals.browser.storage.onChanged
    delete globals.chrome.storage.onChanged

    try {
      const { result } = renderHook(() => usePageMedia())
      await act(async () => {
        await result.current.scan()
      })
      expect(result.current.media).toEqual([])
    } finally {
      globals.browser.storage.onChanged = browserOnChanged
      globals.chrome.storage.onChanged = chromeOnChanged
    }
  })

  it('download asks background to resolve the canonical stored media key', async () => {
    send.mockResolvedValueOnce({ ok: true })
    const { result } = renderHook(() => usePageMedia())
    const media = {
      kind: 'direct' as const,
      url: 'https://h/v.mp4',
      pageUrl: 'p',
      pageTitle: 't',
      detectedAt: 1,
    }
    await act(async () => {
      await result.current.download(media)
    })
    expect(send).toHaveBeenCalledWith('bg.submitMedia', {
      mediaKey: mediaStorageKey(media),
      idempotencyKey: expect.any(String),
    })
  })

  it('requests a page-rendered thumbnail by canonical stored media key', async () => {
    const dataUrl = 'data:image/webp;base64,UklGRg=='
    send.mockResolvedValueOnce({ dataUrl })
    const { result } = renderHook(() => usePageMedia())
    const media = {
      kind: 'direct' as const,
      url: 'https://images.example/hero.webp?token=exact',
      pageUrl: 'https://images.example/gallery',
      pageTitle: 'Hero',
      category: 'image' as const,
      detectedAt: 1,
    }

    await expect(result.current.getThumbnail(media)).resolves.toBe(dataUrl)
    expect(send).toHaveBeenCalledWith('bg.getMediaThumbnail', {
      mediaKey: mediaStorageKey(media),
    })
  })

  it('reuses a resource idempotency key after a lost acknowledgement, then clears it on success', async () => {
    send
      .mockRejectedValueOnce(new Error('response port closed'))
      .mockResolvedValueOnce({ taskId: 'tid-recovered' })
      .mockResolvedValueOnce({ taskId: 'tid-next' })
    const { result } = renderHook(() => usePageMedia('backend-a'))
    const media = {
      kind: 'direct' as const,
      url: 'https://h/retry.mp4',
      pageUrl: 'https://h/watch',
      pageTitle: 'retry',
      detectedAt: 1,
    }

    await act(async () => {
      await expect(result.current.download(media)).rejects.toThrow(
        'response port closed'
      )
    })
    await act(async () => result.current.download(media))
    await act(async () => result.current.download(media))

    const keys = send.mock.calls.map(
      ([, payload]) => (payload as { idempotencyKey: string }).idempotencyKey
    )
    expect(keys[1]).toBe(keys[0])
    expect(keys[2]).not.toBe(keys[1])
  })

  it('restores a resource key after the Popup closes before acknowledgement', async () => {
    const lostAcknowledgement = deferred<{ taskId: string }>()
    send
      .mockImplementationOnce(() => lostAcknowledgement.promise)
      .mockResolvedValueOnce({ taskId: 'tid-recovered' })
    const media = {
      kind: 'direct' as const,
      url: 'https://h/reopen.mp4',
      pageUrl: 'https://h/watch',
      pageTitle: 'reopen',
      detectedAt: 1,
    }

    const first = renderHook(() => usePageMedia('backend-a'))
    act(() => {
      void first.result.current.download(media)
    })
    await waitFor(() => expect(send).toHaveBeenCalledOnce())
    const firstPayload = send.mock.calls[0]?.[1]
    if (!firstPayload) throw new Error('missing first submission')
    const firstKey = (firstPayload as { idempotencyKey: string }).idempotencyKey
    const storageKey = pageMediaSubmissionsSessionKey('backend-a')
    expect((await chrome.storage.session.get(storageKey))[storageKey]).toEqual({
      resources: { [mediaStorageKey(media)]: firstKey },
    })

    first.unmount()
    const reopened = renderHook(() => usePageMedia('backend-a'))
    await act(async () => reopened.result.current.download(media))

    const retryPayload = send.mock.calls[1]?.[1]
    if (!retryPayload) throw new Error('missing retried submission')
    const retryKey = (retryPayload as { idempotencyKey: string }).idempotencyKey
    expect(retryKey).toBe(firstKey)
    expect((await chrome.storage.session.get(storageKey))[storageKey]).toBe(
      undefined
    )
  })

  it('drops failed resource keys when the Backend submission key changes', async () => {
    send
      .mockRejectedValueOnce(new Error('lost acknowledgement'))
      .mockResolvedValueOnce({ taskId: 'tid-new-backend' })
    const { result, rerender } = renderHook(
      ({ backend }) => usePageMedia(backend),
      { initialProps: { backend: 'backend-a' } }
    )
    const media = {
      kind: 'direct' as const,
      url: 'https://h/switch.mp4',
      pageUrl: 'https://h/watch',
      pageTitle: 'switch',
      detectedAt: 1,
    }

    await act(async () => {
      await expect(result.current.download(media)).rejects.toThrow(
        'lost acknowledgement'
      )
    })
    rerender({ backend: 'backend-b' })
    await act(async () => result.current.download(media))

    const first = send.mock.calls[0]?.[1] as { idempotencyKey: string }
    const second = send.mock.calls[1]?.[1] as { idempotencyKey: string }
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey)
  })

  it('error response from bg.scanActiveTab surfaces as error state', async () => {
    send.mockResolvedValueOnce({ error: 'tab not found' })
    const { result } = renderHook(() => usePageMedia())
    await act(async () => {
      await result.current.scan()
    })
    await waitFor(() => expect(result.current.error).toBe('tab not found'))
    expect(result.current.media).toHaveLength(0)
  })

  it('keeps the newest scan result when overlapping requests finish out of order', async () => {
    const first = deferred<{
      media: Array<{
        kind: 'direct'
        url: string
        pageUrl: string
        pageTitle: string
        detectedAt: number
      }>
      selectionKinds: string[]
    }>()
    send
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({
        media: [
          {
            kind: 'hls',
            url: 'https://new.example/master.m3u8',
            pageUrl: 'https://new.example/watch',
            pageTitle: 'New page',
            detectedAt: 2,
          },
        ],
        selectionKinds: ['direct', 'hls'],
      })
    const { result } = renderHook(() => usePageMedia())

    let firstScan!: Promise<void>
    await act(async () => {
      firstScan = result.current.scan()
      await result.current.scan()
    })
    expect(result.current.media[0]?.url).toBe('https://new.example/master.m3u8')

    first.resolve({
      media: [
        {
          kind: 'direct',
          url: 'https://old.example/video.mp4',
          pageUrl: 'https://old.example/watch',
          pageTitle: 'Old page',
          detectedAt: 1,
        },
      ],
      selectionKinds: ['direct'],
    })
    await act(async () => firstScan)

    expect(result.current.media[0]?.url).toBe('https://new.example/master.m3u8')
    expect(result.current.selectionKinds).toContain('hls')
    expect(result.current.scanning).toBe(false)
  })

  it('resolvableSite is null when active tab is a non-video page', async () => {
    tabsQuery.mockResolvedValue([{ url: 'https://example.com/page' }])
    const { result } = renderHook(() => usePageMedia())
    await waitFor(() => {
      // Effect has run; resolvableSite should be null
      expect(result.current.resolvableSite).toBeNull()
    })
  })

  it('resolvableSite is "bilibili" when active tab is a bilibili watch page', async () => {
    tabsQuery.mockResolvedValue([
      { url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
    ])
    const { result } = renderHook(() => usePageMedia())
    await waitFor(() => {
      expect(result.current.resolvableSite).toBe('bilibili')
    })
  })

  it('resolvePageDownload calls send("bg.resolvePageDownload") and returns taskId', async () => {
    send.mockResolvedValueOnce({ taskId: 'tid-xyz' })
    const { result } = renderHook(() => usePageMedia())
    let resolved: { taskId: string } | undefined
    await act(async () => {
      resolved = await result.current.resolvePageDownload()
    })
    expect(send).toHaveBeenCalledWith('bg.resolvePageDownload', {
      idempotencyKey: expect.any(String),
    })
    expect(resolved).toEqual({ taskId: 'tid-xyz' })
  })

  it('reuses a page idempotency key after a lost acknowledgement, then clears it on success', async () => {
    send
      .mockRejectedValueOnce(new Error('response port closed'))
      .mockResolvedValueOnce({ taskId: 'tid-recovered' })
      .mockResolvedValueOnce({ taskId: 'tid-next' })
    const { result } = renderHook(() => usePageMedia('backend-a'))

    await act(async () => {
      await expect(result.current.resolvePageDownload()).rejects.toThrow(
        'response port closed'
      )
    })
    await act(async () => result.current.resolvePageDownload())
    await act(async () => result.current.resolvePageDownload())

    const keys = send.mock.calls.map(
      ([, payload]) => (payload as { idempotencyKey: string }).idempotencyKey
    )
    expect(keys[1]).toBe(keys[0])
    expect(keys[2]).not.toBe(keys[1])
  })

  it('restores a page key after the Popup closes before acknowledgement', async () => {
    const lostAcknowledgement = deferred<{ taskId: string }>()
    send
      .mockImplementationOnce(() => lostAcknowledgement.promise)
      .mockResolvedValueOnce({ taskId: 'tid-recovered' })

    const first = renderHook(() => usePageMedia('backend-a'))
    act(() => {
      void first.result.current.resolvePageDownload()
    })
    await waitFor(() => expect(send).toHaveBeenCalledOnce())
    const firstPayload = send.mock.calls[0]?.[1]
    if (!firstPayload) throw new Error('missing first submission')
    const firstKey = (firstPayload as { idempotencyKey: string }).idempotencyKey
    const storageKey = pageMediaSubmissionsSessionKey('backend-a')
    expect((await chrome.storage.session.get(storageKey))[storageKey]).toEqual({
      resources: {},
      page: firstKey,
    })

    first.unmount()
    const reopened = renderHook(() => usePageMedia('backend-a'))
    await act(async () => reopened.result.current.resolvePageDownload())

    const retryPayload = send.mock.calls[1]?.[1]
    if (!retryPayload) throw new Error('missing retried submission')
    const retryKey = (retryPayload as { idempotencyKey: string }).idempotencyKey
    expect(retryKey).toBe(firstKey)
    expect((await chrome.storage.session.get(storageKey))[storageKey]).toBe(
      undefined
    )
  })

  it('drops a failed page key when the Backend submission key changes', async () => {
    send
      .mockRejectedValueOnce(new Error('lost acknowledgement'))
      .mockResolvedValueOnce({ taskId: 'tid-new-backend' })
    const { result, rerender } = renderHook(
      ({ backend }) => usePageMedia(backend),
      { initialProps: { backend: 'backend-a' } }
    )

    await act(async () => {
      await expect(result.current.resolvePageDownload()).rejects.toThrow(
        'lost acknowledgement'
      )
    })
    rerender({ backend: 'backend-b' })
    await act(async () => result.current.resolvePageDownload())

    const first = send.mock.calls[0]?.[1] as { idempotencyKey: string }
    const second = send.mock.calls[1]?.[1] as { idempotencyKey: string }
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey)
  })

  it('resolvePageDownload throws on error response from bg', async () => {
    send.mockResolvedValueOnce({ error: 'Motrix not connected' })
    const { result } = renderHook(() => usePageMedia())
    await expect(
      act(async () => {
        await result.current.resolvePageDownload()
      })
    ).rejects.toThrow('Motrix not connected')
  })
})
