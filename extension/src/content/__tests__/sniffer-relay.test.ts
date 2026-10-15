// Unit tests for the ISOLATED-world sniffer-relay message handler.
//
// The relay listens for window.postMessage({ source: 'motrix-sniffer', items })
// and forwards the payload to chrome.runtime.sendMessage. Tests run in jsdom
// which provides window and MessageEvent.

import { beforeAll, describe, expect, it, vi } from 'vitest'

const { captureThumbnail } = vi.hoisted(() => ({
  captureThumbnail: vi.fn(() => ({ dataUrl: null })),
}))

vi.mock('@/content/imageThumbnail', () => ({
  imageThumbnailSampler: { capture: captureThumbnail },
}))

// Install a sendMessage mock on the shared chrome stub before importing the relay.
// setup.ts already installs chrome/browser stubs on globalThis; we extend it here.
const sendMessage = vi.fn()
let runtimeListener:
  | ((
      message: unknown,
      sender: unknown,
      sendResponse: (response: unknown) => void
    ) => boolean)
  | undefined
const addRuntimeListener = vi.fn(
  (
    listener: (
      message: unknown,
      sender: unknown,
      sendResponse: (response: unknown) => void
    ) => boolean
  ) => {
    runtimeListener = listener
  }
)
;(
  globalThis as unknown as {
    chrome: {
      runtime: {
        sendMessage: typeof sendMessage
        onMessage: { addListener: typeof addRuntimeListener }
      }
    }
  }
).chrome.runtime.sendMessage = sendMessage
;(
  globalThis as unknown as {
    browser: {
      runtime: {
        sendMessage: typeof sendMessage
        onMessage: { addListener: typeof addRuntimeListener }
      }
    }
  }
).browser.runtime.sendMessage = sendMessage
;(
  globalThis as unknown as {
    browser: {
      runtime: { onMessage: { addListener: typeof addRuntimeListener } }
    }
  }
).browser.runtime.onMessage.addListener = addRuntimeListener

// Load the relay. Its window.addEventListener('message', …) is registered at
// module-evaluation time and persists for the lifetime of this test file.
beforeAll(async () => {
  delete (window as Window & { __motrixSnifferRelayInstalled?: boolean })
    .__motrixSnifferRelayInstalled
  await import('@/content/sniffer-relay')
})

// Helper: dispatch a MessageEvent on window simulating a same-window postMessage.
function dispatch(data: unknown, source: Window | null = window): void {
  const evt = new MessageEvent('message', { data, source })
  window.dispatchEvent(evt)
}

describe('sniffer-relay', () => {
  it('answers a MAIN-world hello so either document_start order is lossless', () => {
    sendMessage.mockReset()
    const postMessage = vi.spyOn(window, 'postMessage')

    dispatch({ source: 'motrix-sniffer', type: 'hello' })

    expect(postMessage).toHaveBeenCalledWith(
      { source: 'motrix-sniffer-relay', type: 'ready' },
      '*'
    )
    expect(sendMessage).not.toHaveBeenCalled()
    postMessage.mockRestore()
  })

  it('forwards a valid motrix-sniffer message to chrome.runtime.sendMessage', async () => {
    sendMessage.mockReset()
    const items = [
      {
        kind: 'hls',
        url: 'https://cdn/v.m3u8',
        pageUrl: 'https://page',
        pageTitle: 'P',
        detectedAt: 1,
      },
    ]

    dispatch({ source: 'motrix-sniffer', items })
    await Promise.resolve()

    expect(sendMessage).toHaveBeenCalledOnce()
    expect(sendMessage).toHaveBeenCalledWith({
      kind: 'bg.mediaDetected',
      payload: { tabUrl: location.href, items },
    })
  })

  it('ignores messages with a foreign source tag', () => {
    sendMessage.mockReset()
    dispatch({ source: 'some-other-extension', items: [] })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('ignores messages with no source tag', () => {
    sendMessage.mockReset()
    dispatch({ items: [{ url: 'https://cdn/v.m3u8' }] })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('ignores messages where items is not an array', () => {
    sendMessage.mockReset()
    dispatch({ source: 'motrix-sniffer', items: 'not-an-array' })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('ignores messages from a different window (e.source !== window)', () => {
    sendMessage.mockReset()
    const items = [{ kind: 'hls', url: 'https://cdn/v.m3u8' }]
    // Pass null as source to simulate a cross-origin frame (e.source !== window)
    dispatch({ source: 'motrix-sniffer', items }, null)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('does not register a duplicate listener when reinjected', async () => {
    vi.resetModules()
    await import('@/content/sniffer-relay')
    sendMessage.mockReset()

    const items = [
      {
        kind: 'direct',
        url: 'https://cdn/v.mp4',
        pageUrl: 'https://page.example/',
        pageTitle: 'Page',
        detectedAt: 1,
      },
    ]
    dispatch({ source: 'motrix-sniffer', items })
    await Promise.resolve()

    expect(sendMessage).toHaveBeenCalledOnce()
  })

  it('answers image thumbnail requests only over the extension runtime channel', async () => {
    const response = { dataUrl: 'data:image/webp;base64,V0VCUA==' }
    captureThumbnail.mockReturnValueOnce(response)
    const sendResponse = vi.fn()
    if (!runtimeListener) throw new Error('runtime listener not attached')

    const handled = runtimeListener(
      {
        kind: 'content.imageThumbnail',
        payload: { url: 'https://cdn.example/photo.jpg', maxEdge: 72 },
      },
      {},
      sendResponse
    )
    expect(handled).toBe(true)
    expect(sendResponse).not.toHaveBeenCalled()
    await Promise.resolve()
    await Promise.resolve()

    expect(captureThumbnail).toHaveBeenCalledWith({
      url: 'https://cdn.example/photo.jpg',
      maxEdge: 72,
    })
    expect(sendResponse).toHaveBeenCalledWith(response)
  })

  it('does not expose thumbnail capture through page postMessage', async () => {
    captureThumbnail.mockClear()
    dispatch({
      kind: 'content.imageThumbnail',
      payload: { url: 'https://cdn.example/photo.jpg' },
    })
    await Promise.resolve()

    expect(captureThumbnail).not.toHaveBeenCalled()
  })

  it('bounds item count and strips nested page-controlled fields before IPC', async () => {
    sendMessage.mockReset()
    const items = Array.from({ length: 125 }, (_, index) => ({
      kind: 'direct',
      url: `https://cdn.example/${index}.jpg`,
      pageUrl: 'https://page.example/',
      pageTitle: 'Page',
      detectedAt: 1,
      evidence: Array.from({ length: 20 }, () => 'img'),
      requestHeaders: { Authorization: 'secret' },
      arbitrary: { deeply: { nested: 'payload' } },
    }))

    dispatch({ source: 'motrix-sniffer', type: 'media', items })
    await Promise.resolve()

    const forwarded = sendMessage.mock.calls[0]?.[0] as {
      payload?: { items?: Record<string, unknown>[] }
    }
    expect(forwarded.payload?.items).toHaveLength(100)
    expect(forwarded.payload?.items?.[0]).not.toHaveProperty('requestHeaders')
    expect(forwarded.payload?.items?.[0]).not.toHaveProperty('arbitrary')
    expect(forwarded.payload?.items?.[0]?.evidence).toHaveLength(8)
  })

  it('keeps even many maximum-length mux audio URLs below the packet budget', async () => {
    sendMessage.mockReset()
    const items = Array.from({ length: 100 }, (_, index) => ({
      kind: 'mux',
      url: `https://cdn.example/${index}.mp4`,
      audioUrl: `https://audio.example/${'a'.repeat(32_768)}`,
      pageUrl: 'https://page.example/',
      pageTitle: 'Page',
      detectedAt: 1,
    }))

    dispatch({ source: 'motrix-sniffer', type: 'media', items })
    await Promise.resolve()

    expect(sendMessage).toHaveBeenCalledOnce()
    const packet = sendMessage.mock.calls[0]?.[0]
    expect(
      new TextEncoder().encode(JSON.stringify(packet)).byteLength
    ).toBeLessThanOrEqual(256 * 1024)
  })

  it('coalesces and rate-limits a sustained page-message flood per frame', async () => {
    vi.useFakeTimers()
    sendMessage.mockReset()
    for (let index = 0; index < 1_000; index += 1) {
      dispatch({
        source: 'motrix-sniffer',
        type: 'media',
        items: [
          {
            kind: 'direct',
            url: `https://cdn.example/flood/${index}.jpg`,
            pageUrl: 'https://page.example/',
            pageTitle: 'Page',
            detectedAt: index + 1,
          },
        ],
      })
    }

    await vi.runAllTicks()
    const firstWindowItems = sendMessage.mock.calls.reduce(
      (total, [message]) =>
        total +
        (((message as { payload?: { items?: unknown[] } }).payload?.items
          ?.length ?? 0) as number),
      0
    )
    expect(firstWindowItems).toBeLessThanOrEqual(300)
    expect(sendMessage.mock.calls.length).toBeLessThanOrEqual(3)

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.runAllTicks()
    const allItems = sendMessage.mock.calls.reduce(
      (total, [message]) =>
        total +
        (((message as { payload?: { items?: unknown[] } }).payload?.items
          ?.length ?? 0) as number),
      0
    )
    expect(allItems).toBeLessThanOrEqual(400)
    vi.useRealTimers()
  })
})
