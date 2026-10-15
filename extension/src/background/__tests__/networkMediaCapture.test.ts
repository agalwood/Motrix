import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_PENDING_REQUEST_HEADERS,
  NETWORK_MEDIA_REQUEST_TYPES,
  type NetworkRequestDetails,
  type NetworkResponseDetails,
  REQUEST_HEADERS_TTL_MS,
  registerNetworkMediaCapture,
} from '@/background/networkMediaCapture'
import { extensionBrowser } from '@/shared/browser'

function request(
  changes: Partial<NetworkRequestDetails> = {}
): NetworkRequestDetails {
  return {
    requestId: 'request-1',
    tabId: 7,
    type: 'media',
    url: 'https://cdn.example/video.mp4',
    frameId: 0,
    parentFrameId: -1,
    timeStamp: 122,
    initiator: 'https://page.example',
    documentId: 'top-document',
    documentUrl: 'https://page.example/watch',
    requestHeaders: [
      { name: 'Accept', value: 'video/*' },
      { name: 'Referer', value: 'https://page.example/watch' },
      { name: 'Cookie', value: 'do-not-store=1' },
    ],
    ...changes,
  }
}

function response(
  changes: Partial<NetworkResponseDetails> = {}
): NetworkResponseDetails {
  return {
    requestId: 'request-1',
    tabId: 7,
    type: 'media',
    url: 'https://cdn.example/video.mp4',
    frameId: 0,
    parentFrameId: -1,
    timeStamp: 123,
    initiator: 'https://page.example',
    documentId: 'top-document',
    documentUrl: 'https://page.example/watch',
    statusCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }],
    ...changes,
  }
}

interface NavigationFrame {
  tabId: number
  frameId: number
  parentFrameId: number
  url: string
  documentId?: string
}

function setup(
  options: {
    tabResults?: Array<{ url?: string; title?: string }>
    frames?: NavigationFrame[]
    frameResults?: Array<NavigationFrame[] | null | Error>
    webStore?: boolean
    rejectStore?: boolean
    failHeadersRegistration?: boolean
    includeExtraHeaders?: boolean
    failExtraHeadersRegistration?: boolean
  } = {}
) {
  let sendHeadersListener:
    | ((details: NetworkRequestDetails) => void)
    | undefined
  let headersListener: ((details: NetworkResponseDetails) => void) | undefined
  let updatedListener:
    | ((
        tabId: number,
        changeInfo: { url?: string },
        tab: { url?: string; title?: string }
      ) => void)
    | undefined
  let removedListener:
    | ((
        tabId: number,
        removeInfo: { isWindowClosing: boolean; windowId: number }
      ) => void)
    | undefined
  let committedListener: ((details: NavigationFrame) => void) | undefined
  let historyListener: ((details: NavigationFrame) => void) | undefined
  const addHeadersListener = vi.fn(
    (listener: (details: NetworkResponseDetails) => void) => {
      if (options.failHeadersRegistration) {
        throw new Error('listener registration failed')
      }
      headersListener = listener
    }
  )
  const removeHeadersListener = vi.fn()
  const addSendHeadersListener = vi.fn(
    (
      listener: (details: NetworkRequestDetails) => void,
      _filter?: unknown,
      extraInfoSpec?: string[]
    ) => {
      if (
        options.failExtraHeadersRegistration &&
        extraInfoSpec?.includes('extraHeaders')
      ) {
        throw new Error('extraHeaders is unsupported')
      }
      sendHeadersListener = listener
    }
  )
  const removeSendHeadersListener = vi.fn()
  const addUpdatedListener = vi.fn(
    (
      listener: (
        tabId: number,
        changeInfo: { url?: string },
        tab: { url?: string; title?: string }
      ) => void
    ) => {
      updatedListener = listener
    }
  )
  const removeUpdatedListener = vi.fn()
  const addRemovedListener = vi.fn(
    (
      listener: (
        tabId: number,
        removeInfo: { isWindowClosing: boolean; windowId: number }
      ) => void
    ) => {
      removedListener = listener
    }
  )
  const removeRemovedListener = vi.fn()
  const addCommittedListener = vi.fn(
    (listener: (details: NavigationFrame) => void) => {
      committedListener = listener
    }
  )
  const removeCommittedListener = vi.fn()
  const addHistoryListener = vi.fn(
    (listener: (details: NavigationFrame) => void) => {
      historyListener = listener
    }
  )
  const removeHistoryListener = vi.fn()
  const tabResults = options.tabResults ?? [
    { url: 'https://page.example/watch', title: 'Watch page' },
  ]
  let tabRead = 0
  const getTab = vi.fn(async () => {
    const result = tabResults[Math.min(tabRead, tabResults.length - 1)]
    tabRead += 1
    return result ?? {}
  })
  const defaultFrames: NavigationFrame[] = options.frames ?? [
    {
      tabId: 7,
      frameId: 0,
      parentFrameId: -1,
      url: 'https://page.example/watch',
      documentId: 'top-document',
    },
  ]
  let frameRead = 0
  const getAllFrames = vi.fn(async () => {
    const result = options.frameResults
      ? options.frameResults[
          Math.min(frameRead, options.frameResults.length - 1)
        ]
      : defaultFrames
    frameRead += 1
    if (result instanceof Error) throw result
    return result ?? null
  })
  const storeError = new Error('session storage unavailable')
  const addForPage = vi.fn(async () => {
    if (options.rejectStore) throw storeError
  })
  const retainPage = vi.fn(async () => {
    if (options.rejectStore) throw storeError
  })
  const clear = vi.fn(async () => {
    if (options.rejectStore) throw storeError
  })
  const rememberCredential = vi.fn()
  const retainCredentials = vi.fn()
  const clearCredentials = vi.fn()
  const clearAllCredentials = vi.fn()
  let nowValue = 999

  const unregister = registerNetworkMediaCapture({
    store: { addForPage, retainPage, clear },
    credentialStore: {
      remember: rememberCredential,
      retainPage: retainCredentials,
      clear: clearCredentials,
      clearAll: clearAllCredentials,
    },
    webRequest: {
      onSendHeaders: {
        addListener: addSendHeadersListener,
        removeListener: removeSendHeadersListener,
      },
      onHeadersReceived: {
        addListener: addHeadersListener,
        removeListener: removeHeadersListener,
      },
    },
    webNavigation: {
      getAllFrames,
      onCommitted: {
        addListener: addCommittedListener,
        removeListener: removeCommittedListener,
      },
      onHistoryStateUpdated: {
        addListener: addHistoryListener,
        removeListener: removeHistoryListener,
      },
    },
    tabs: {
      get: getTab,
      onUpdated: {
        addListener: addUpdatedListener,
        removeListener: removeUpdatedListener,
      },
      onRemoved: {
        addListener: addRemovedListener,
        removeListener: removeRemovedListener,
      },
    },
    webStore: options.webStore ?? false,
    includeExtraHeaders: options.includeExtraHeaders ?? false,
    now: () => nowValue,
  })

  return {
    addForPage,
    addHeadersListener,
    addSendHeadersListener,
    advanceNow: (milliseconds: number) => {
      nowValue += milliseconds
    },
    committedListener: () => committedListener,
    clear,
    clearAllCredentials,
    clearCredentials,
    getAllFrames,
    getTab,
    headersListener: () => headersListener,
    sendHeadersListener: () => sendHeadersListener,
    removedListener: () => removedListener,
    historyListener: () => historyListener,
    rememberCredential,
    retainPage,
    retainCredentials,
    unregister,
    updatedListener: () => updatedListener,
    removeHeadersListener,
    removeSendHeadersListener,
    removeCommittedListener,
    removeHistoryListener,
    removeRemovedListener,
    removeUpdatedListener,
  }
}

describe('registerNetworkMediaCapture', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('registers passive request and response listeners for relevant types', () => {
    const harness = setup()

    expect(harness.addSendHeadersListener).toHaveBeenCalledWith(
      expect.any(Function),
      {
        urls: ['http://*/*', 'https://*/*'],
        types: [...NETWORK_MEDIA_REQUEST_TYPES],
      },
      ['requestHeaders']
    )
    expect(harness.addHeadersListener).toHaveBeenCalledWith(
      expect.any(Function),
      {
        urls: ['http://*/*', 'https://*/*'],
        types: [...NETWORK_MEDIA_REQUEST_TYPES],
      },
      ['responseHeaders']
    )
    expect(NETWORK_MEDIA_REQUEST_TYPES).toContain('image')

    harness.unregister()
    expect(harness.removeSendHeadersListener).toHaveBeenCalledOnce()
    expect(harness.removeHeadersListener).toHaveBeenCalledOnce()
    expect(harness.removeCommittedListener).toHaveBeenCalledOnce()
    expect(harness.removeHistoryListener).toHaveBeenCalledOnce()
    expect(harness.removeUpdatedListener).toHaveBeenCalledOnce()
    expect(harness.removeRemovedListener).toHaveBeenCalledOnce()
    expect(harness.clearAllCredentials).toHaveBeenCalledOnce()
  })

  it('requests extraHeaders only when explicitly enabled', () => {
    const harness = setup({ includeExtraHeaders: true })

    expect(harness.addSendHeadersListener).toHaveBeenCalledWith(
      expect.any(Function),
      {
        urls: ['http://*/*', 'https://*/*'],
        types: [...NETWORK_MEDIA_REQUEST_TYPES],
      },
      ['requestHeaders', 'extraHeaders']
    )
    harness.unregister()
  })

  it('falls back to ordinary request headers when extraHeaders is unsupported', () => {
    const harness = setup({
      includeExtraHeaders: true,
      failExtraHeadersRegistration: true,
    })

    expect(harness.addSendHeadersListener).toHaveBeenCalledTimes(2)
    expect(harness.addSendHeadersListener).toHaveBeenLastCalledWith(
      expect.any(Function),
      {
        urls: ['http://*/*', 'https://*/*'],
        types: [...NETWORK_MEDIA_REQUEST_TYPES],
      },
      ['requestHeaders']
    )
    expect(harness.sendHeadersListener()).toEqual(expect.any(Function))
    harness.unregister()
    expect(harness.removeSendHeadersListener).toHaveBeenCalledOnce()
  })

  it('captures a MIME-only URL without any Backend manager dependency', async () => {
    const harness = setup()

    harness.headersListener()?.(
      response({
        url: 'https://cdn.example/download?id=42',
        responseHeaders: [
          { name: 'content-type', value: 'Video/WebM; codecs="vp9"' },
        ],
      })
    )

    await vi.waitFor(() => expect(harness.addForPage).toHaveBeenCalledOnce())
    expect(harness.addForPage).toHaveBeenCalledWith(
      7,
      'https://page.example/watch',
      [
        expect.objectContaining({
          kind: 'direct',
          url: 'https://cdn.example/download?id=42',
          pageUrl: 'https://page.example/watch',
          pageTitle: 'Watch page',
          detectedAt: 123,
          mimeType: 'video/webm',
          category: 'video',
          suggestedFilename: 'download.webm',
          frameUrl: 'https://page.example/watch',
          evidence: ['network', 'content-type'],
        }),
      ]
    )
  })

  it('classifies an extensionless image and derives its filename from MIME', async () => {
    const harness = setup()

    harness.sendHeadersListener()?.(
      request({
        type: 'image',
        url: 'https://cdn.example/render?id=42',
        requestHeaders: [
          { name: 'Referer', value: 'https://page.example/watch' },
        ],
      })
    )
    harness.headersListener()?.(
      response({
        type: 'image',
        url: 'https://cdn.example/render?id=42',
        responseHeaders: [
          { name: 'Content-Type', value: 'image/avif; charset=binary' },
          { name: 'Content-Length', value: '4096' },
        ],
      })
    )

    await vi.waitFor(() => expect(harness.addForPage).toHaveBeenCalledOnce())
    expect(harness.addForPage.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({
        category: 'image',
        mimeType: 'image/avif',
        previewable: true,
        sizeBytes: 4096,
        suggestedFilename: 'render.avif',
        frameUrl: 'https://page.example/watch',
        evidence: ['network', 'content-type', 'content-length'],
      }),
    ])
    expect(harness.addForPage.mock.calls[0]?.[2]?.[0]).not.toHaveProperty(
      'requestHeaders'
    )
    expect(harness.rememberCredential).toHaveBeenCalledWith({
      tabId: 7,
      pageUrl: 'https://page.example/watch',
      url: 'https://cdn.example/render?id=42',
      observedAt: 999,
      requestHeaders: { Referer: 'https://page.example/watch' },
    })
  })

  it('keeps observed request context private and excludes Authorization', async () => {
    const harness = setup()

    harness.sendHeadersListener()?.(
      request({
        requestHeaders: [
          { name: 'authorization', value: 'Bearer media-token' },
          { name: 'ORIGIN', value: 'https://page.example' },
          { name: 'Referer', value: 'https://page.example/watch' },
          { name: 'Accept', value: 'video/*' },
          { name: 'Accept-Language', value: 'zh-CN' },
          { name: 'User-Agent', value: 'Browser Test' },
          { name: 'X-Requested-With', value: 'fetch' },
          { name: 'Cookie', value: 'private=1' },
        ],
      })
    )
    harness.headersListener()?.(response())

    await vi.waitFor(() => expect(harness.addForPage).toHaveBeenCalledOnce())
    expect(harness.addForPage.mock.calls[0]?.[2]?.[0]).not.toHaveProperty(
      'requestHeaders'
    )
    expect(harness.rememberCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        requestHeaders: {
          Cookie: 'private=1',
          Origin: 'https://page.example',
          Referer: 'https://page.example/watch',
          Accept: 'video/*',
          'Accept-Language': 'zh-CN',
          'User-Agent': 'Browser Test',
          'X-Requested-With': 'fetch',
        },
      })
    )
    expect(
      harness.rememberCredential.mock.calls[0]?.[0]?.requestHeaders
    ).not.toHaveProperty('Authorization')
  })

  it('uses Content-Range total over chunk length for a 206 response', async () => {
    const harness = setup()

    harness.headersListener()?.(
      response({
        statusCode: 206,
        responseHeaders: [
          { name: 'Content-Type', value: 'video/mp4' },
          {
            name: 'Content-Disposition',
            value:
              "attachment; filename=backup.mp4; filename*=UTF-8''Film%20Final.mp4",
          },
          { name: 'Content-Range', value: 'bytes 0-999/12345' },
          { name: 'Content-Length', value: '1000' },
          { name: 'Accept-Ranges', value: 'bytes' },
        ],
      })
    )

    await vi.waitFor(() => expect(harness.addForPage).toHaveBeenCalledOnce())
    expect(harness.addForPage.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({
        sizeBytes: 12345,
        suggestedFilename: 'Film Final.mp4',
        evidence: [
          'network',
          'content-type',
          'content-disposition',
          'content-range',
          'accept-ranges',
        ],
      }),
    ])
  })

  it('removes bidi controls and replaces a dangerous filename using response MIME', async () => {
    const harness = setup()

    harness.headersListener()?.(
      response({
        type: 'image',
        url: 'https://cdn.example/render?id=7',
        responseHeaders: [
          { name: 'Content-Type', value: 'image/png' },
          {
            name: 'Content-Disposition',
            value: "attachment; filename*=UTF-8''photo%E2%80%AEgnp.exe",
          },
        ],
      })
    )

    await vi.waitFor(() => expect(harness.addForPage).toHaveBeenCalledOnce())
    expect(harness.addForPage.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({
        category: 'image',
        mimeType: 'image/png',
        suggestedFilename: 'photognp.png',
      }),
    ])
  })

  it('uses manifest extensions for HLS and DASH network records', async () => {
    const harness = setup()

    harness.headersListener()?.(
      response({
        requestId: 'hls-request',
        url: 'https://cdn.example/manifest?id=hls',
        responseHeaders: [
          {
            name: 'Content-Type',
            value: 'application/vnd.apple.mpegurl',
          },
          {
            name: 'Content-Disposition',
            value: 'attachment; filename=playlist.exe',
          },
        ],
      })
    )
    harness.headersListener()?.(
      response({
        requestId: 'dash-request',
        url: 'https://cdn.example/manifest?id=dash',
        responseHeaders: [
          { name: 'Content-Type', value: 'application/dash+xml' },
          {
            name: 'Content-Disposition',
            value: 'attachment; filename=manifest.svg',
          },
        ],
      })
    )

    await vi.waitFor(() => expect(harness.addForPage).toHaveBeenCalledTimes(2))
    expect(harness.addForPage.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({
        kind: 'hls',
        suggestedFilename: 'playlist.m3u8',
      }),
    ])
    expect(harness.addForPage.mock.calls[1]?.[2]).toEqual([
      expect.objectContaining({
        kind: 'dash',
        suggestedFilename: 'manifest.mpd',
      }),
    ])
  })

  it('refreshes correlation across redirects without leaking old headers', async () => {
    const harness = setup()

    harness.sendHeadersListener()?.(
      request({
        url: 'https://cdn.example/redirect',
        requestHeaders: [
          { name: 'X-Requested-With', value: 'redirect-request' },
        ],
      })
    )
    harness.headersListener()?.(
      response({
        url: 'https://cdn.example/redirect',
        statusCode: 302,
        responseHeaders: [
          { name: 'Content-Type', value: 'image/png' },
          { name: 'Location', value: 'https://cdn.example/final.png' },
        ],
      })
    )
    harness.sendHeadersListener()?.(
      request({
        url: 'https://cdn.example/final.png',
        requestHeaders: [{ name: 'X-Requested-With', value: 'final-request' }],
      })
    )
    harness.headersListener()?.(
      response({
        type: 'image',
        url: 'https://cdn.example/final.png',
        responseHeaders: [{ name: 'Content-Type', value: 'image/png' }],
      })
    )

    await vi.waitFor(() => expect(harness.addForPage).toHaveBeenCalledOnce())
    expect(harness.addForPage.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({
        url: 'https://cdn.example/final.png',
      }),
    ])
    expect(harness.addForPage.mock.calls[0]?.[2]?.[0]).not.toHaveProperty(
      'requestHeaders'
    )
    expect(harness.rememberCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://cdn.example/final.png',
        requestHeaders: { 'X-Requested-With': 'final-request' },
      })
    )
  })

  it('isolates pending headers by both tab and request id', async () => {
    const harness = setup()

    harness.sendHeadersListener()?.(
      request({
        requestId: 'shared-id',
        requestHeaders: [{ name: 'Origin', value: 'https://tab-seven.test' }],
      })
    )
    harness.sendHeadersListener()?.(
      request({
        requestId: 'shared-id',
        tabId: 8,
        requestHeaders: [{ name: 'Origin', value: 'https://tab-eight.test' }],
      })
    )
    harness.sendHeadersListener()?.(
      request({
        requestId: 'other-id',
        requestHeaders: [{ name: 'Origin', value: 'https://other.test' }],
      })
    )
    harness.headersListener()?.(response({ requestId: 'shared-id' }))

    await vi.waitFor(() => expect(harness.addForPage).toHaveBeenCalledOnce())
    expect(harness.addForPage.mock.calls[0]?.[2]?.[0]).not.toHaveProperty(
      'requestHeaders'
    )
    expect(harness.rememberCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        requestHeaders: { Origin: 'https://tab-seven.test' },
      })
    )
  })

  it('expires pending headers after the short correlation TTL', async () => {
    const harness = setup()

    harness.sendHeadersListener()?.(
      request({
        requestHeaders: [{ name: 'Origin', value: 'https://expired.test' }],
      })
    )
    harness.advanceNow(REQUEST_HEADERS_TTL_MS + 1)
    harness.headersListener()?.(response())

    await vi.waitFor(() => expect(harness.addForPage).toHaveBeenCalledOnce())
    expect(harness.addForPage.mock.calls[0]?.[2]?.[0]).not.toHaveProperty(
      'requestHeaders'
    )
    expect(harness.rememberCredential).toHaveBeenCalledWith(
      expect.objectContaining({ requestHeaders: {} })
    )
  })

  it('bounds pending request metadata and evicts the oldest entry', async () => {
    const harness = setup()

    for (let index = 0; index <= MAX_PENDING_REQUEST_HEADERS; index += 1) {
      harness.sendHeadersListener()?.(
        request({
          requestId: `bounded-${index}`,
          requestHeaders: [
            { name: 'Accept-Language', value: `language-${index}` },
          ],
        })
      )
    }
    harness.headersListener()?.(response({ requestId: 'bounded-0' }))
    harness.headersListener()?.(
      response({ requestId: `bounded-${MAX_PENDING_REQUEST_HEADERS}` })
    )

    await vi.waitFor(() => expect(harness.addForPage).toHaveBeenCalledTimes(2))
    expect(harness.addForPage.mock.calls[0]?.[2]?.[0]).not.toHaveProperty(
      'requestHeaders'
    )
    expect(harness.addForPage.mock.calls[1]?.[2]?.[0]).not.toHaveProperty(
      'requestHeaders'
    )
    expect(harness.rememberCredential).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requestHeaders: {
          'Accept-Language': `language-${MAX_PENDING_REQUEST_HEADERS}`,
        },
      })
    )
  })

  it('captures raster and SVG images but marks SVG as non-previewable', async () => {
    const harness = setup()

    harness.headersListener()?.(
      response({
        type: 'image',
        url: 'https://cdn.example/cover?id=1',
        responseHeaders: [{ name: 'CONTENT-TYPE', value: 'image/avif' }],
      })
    )
    await vi.waitFor(() => expect(harness.addForPage).toHaveBeenCalledOnce())

    harness.headersListener()?.(
      response({
        type: 'image',
        url: 'https://cdn.example/logo.svgz',
        responseHeaders: [{ name: 'content-type', value: 'image/svg+xml' }],
      })
    )
    await vi.waitFor(() => expect(harness.addForPage).toHaveBeenCalledTimes(2))

    expect(harness.addForPage.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({
        category: 'image',
        mimeType: 'image/avif',
        previewable: true,
      }),
    ])
    expect(harness.addForPage.mock.calls[1]?.[2]).toEqual([
      expect.objectContaining({
        category: 'image',
        mimeType: 'image/svg+xml',
        previewable: false,
        suggestedFilename: 'logo.svgz',
      }),
    ])
  })

  it('ignores non-media, noisy segments, invalid protocols and tabless events', async () => {
    const harness = setup()

    for (const details of [
      response({
        url: 'https://cdn.example/api',
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
      }),
      response({
        url: 'https://cdn.example/chunk.ts?token=1',
        responseHeaders: [{ name: 'content-type', value: 'video/mp2t' }],
      }),
      response({
        url: 'https://cdn.example/chunk.m4s',
        responseHeaders: [{ name: 'content-type', value: 'video/mp4' }],
      }),
      response({ url: 'data:video/mp4;base64,AAAA' }),
      response({ url: 'ftp://cdn.example/video.mp4' }),
      response({ tabId: -1 }),
    ]) {
      harness.headersListener()?.(details)
    }
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect(harness.getTab).not.toHaveBeenCalled()
    expect(harness.addForPage).not.toHaveBeenCalled()
  })

  it('applies Web Store host exclusions before reading the tab', async () => {
    const harness = setup({ webStore: true })

    harness.headersListener()?.(
      response({ url: 'https://rr1.googlevideo.com/videoplayback.mp4' })
    )
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect(harness.getTab).not.toHaveBeenCalled()
    expect(harness.addForPage).not.toHaveBeenCalled()
  })

  it('excludes third-party resources when the top Web Store page is YouTube', async () => {
    const pageUrl = 'https://www.youtube.com/watch?v=motrix'
    const harness = setup({
      webStore: true,
      tabResults: [{ url: pageUrl, title: 'YouTube' }],
      frames: [
        {
          tabId: 7,
          frameId: 0,
          parentFrameId: -1,
          url: pageUrl,
          documentId: 'top-document',
        },
      ],
    })

    harness.headersListener()?.(
      response({
        url: 'https://third-party.example/video.mp4',
        documentUrl: pageUrl,
      })
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(harness.addForPage).not.toHaveBeenCalled()
  })

  it('fails closed on request headers before a cold Web Store worker authenticates the top page', async () => {
    const pageUrl = 'https://www.youtube.com/watch?v=cold-worker'
    const harness = setup({
      webStore: true,
      tabResults: [{ url: pageUrl, title: 'YouTube' }],
      frames: [
        {
          tabId: 7,
          frameId: 0,
          parentFrameId: -1,
          url: pageUrl,
          documentId: 'top-document',
        },
      ],
    })

    harness.sendHeadersListener()?.(
      request({
        url: 'https://third-party.example/video.mp4',
        documentUrl: 'https://iframe.example/player',
        requestHeaders: [
          { name: 'Cookie', value: 'must-not-be-retained=1' },
          { name: 'Referer', value: pageUrl },
        ],
      })
    )
    harness.headersListener()?.(
      response({
        url: 'https://third-party.example/video.mp4',
        documentUrl: pageUrl,
      })
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(harness.rememberCredential).not.toHaveBeenCalled()
    expect(harness.addForPage).not.toHaveBeenCalled()
  })

  it('does not attribute an old same-origin document to a newly navigated page', async () => {
    const harness = setup({
      tabResults: [{ url: 'https://page.example/new', title: 'New page' }],
    })

    harness.committedListener()?.({
      tabId: 7,
      frameId: 0,
      parentFrameId: -1,
      url: 'https://page.example/new',
      documentId: 'new-document',
    })
    harness.headersListener()?.(
      response({
        initiator: 'https://page.example',
        documentId: 'old-document',
        documentUrl: 'https://page.example/old',
      })
    )
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect(harness.addForPage).not.toHaveBeenCalled()
  })

  it('clears pending request headers when the top page navigates', async () => {
    const harness = setup({
      tabResults: [{ url: 'https://page.example/new', title: 'New page' }],
    })

    harness.sendHeadersListener()?.(
      request({
        requestHeaders: [{ name: 'Origin', value: 'https://old.example' }],
      })
    )
    harness.historyListener()?.({
      tabId: 7,
      frameId: 0,
      parentFrameId: -1,
      url: 'https://page.example/new',
      documentId: 'top-document',
    })
    harness.headersListener()?.(
      response({
        documentId: undefined,
        documentUrl: 'https://page.example/new',
      })
    )

    await vi.waitFor(() => expect(harness.addForPage).toHaveBeenCalledOnce())
    expect(harness.addForPage.mock.calls[0]?.[2]?.[0]).not.toHaveProperty(
      'requestHeaders'
    )
    expect(harness.rememberCredential).toHaveBeenCalledWith(
      expect.objectContaining({ requestHeaders: {} })
    )
  })

  it('drops a response when the live tab no longer matches its cached owner', async () => {
    const harness = setup({
      tabResults: [{ url: 'https://page.example/new', title: 'New' }],
    })

    harness.committedListener()?.({
      tabId: 7,
      frameId: 0,
      parentFrameId: -1,
      url: 'https://page.example/old',
      documentId: 'old-document',
    })
    harness.headersListener()?.(
      response({
        documentId: 'old-document',
        documentUrl: 'https://page.example/old',
      })
    )
    await vi.waitFor(() => expect(harness.getTab).toHaveBeenCalledOnce())

    expect(harness.addForPage).not.toHaveBeenCalled()
  })

  it('attributes a current same-origin iframe response to its top page', async () => {
    const harness = setup({
      frames: [
        {
          tabId: 7,
          frameId: 0,
          parentFrameId: -1,
          url: 'https://page.example/watch',
          documentId: 'top-document',
        },
        {
          tabId: 7,
          frameId: 1,
          parentFrameId: 0,
          url: 'https://page.example/player',
          documentId: 'same-origin-frame',
        },
      ],
    })

    harness.headersListener()?.(
      response({
        frameId: 1,
        parentFrameId: 0,
        documentId: 'same-origin-frame',
        documentUrl: 'https://page.example/player',
      })
    )

    await vi.waitFor(() => expect(harness.addForPage).toHaveBeenCalledOnce())
    expect(harness.addForPage).toHaveBeenCalledWith(
      7,
      'https://page.example/watch',
      [expect.objectContaining({ pageUrl: 'https://page.example/watch' })]
    )
  })

  it('attributes a current cross-origin iframe response to its top page', async () => {
    const harness = setup({
      frames: [
        {
          tabId: 7,
          frameId: 0,
          parentFrameId: -1,
          url: 'https://page.example/watch',
          documentId: 'top-document',
        },
        {
          tabId: 7,
          frameId: 2,
          parentFrameId: 0,
          url: 'https://player.example/embed',
          documentId: 'cross-origin-frame',
        },
      ],
    })

    harness.sendHeadersListener()?.(
      request({
        frameId: 2,
        parentFrameId: 0,
        documentId: 'cross-origin-frame',
        documentUrl: 'https://player.example/embed',
        requestHeaders: [
          { name: 'Referer', value: 'https://player.example/embed' },
        ],
      })
    )
    harness.headersListener()?.(
      response({
        frameId: 2,
        parentFrameId: 0,
        documentId: 'cross-origin-frame',
        documentUrl: 'https://player.example/embed',
      })
    )

    await vi.waitFor(() => expect(harness.addForPage).toHaveBeenCalledOnce())
    expect(harness.addForPage.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({
        frameUrl: 'https://player.example/embed',
        pageUrl: 'https://page.example/watch',
        url: 'https://cdn.example/video.mp4',
      }),
    ])
    expect(harness.addForPage.mock.calls[0]?.[2]?.[0]).not.toHaveProperty(
      'requestHeaders'
    )
    expect(harness.rememberCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        requestHeaders: { Referer: 'https://player.example/embed' },
      })
    )
  })

  it('rejects an old iframe response after that frame navigates', async () => {
    const harness = setup()

    harness.committedListener()?.({
      tabId: 7,
      frameId: 0,
      parentFrameId: -1,
      url: 'https://page.example/watch',
      documentId: 'top-document',
    })
    harness.committedListener()?.({
      tabId: 7,
      frameId: 3,
      parentFrameId: 0,
      url: 'https://player.example/old',
      documentId: 'old-frame-document',
    })
    harness.committedListener()?.({
      tabId: 7,
      frameId: 3,
      parentFrameId: 0,
      url: 'https://player.example/new',
      documentId: 'new-frame-document',
    })
    harness.headersListener()?.(
      response({
        frameId: 3,
        parentFrameId: 0,
        documentId: 'old-frame-document',
        documentUrl: 'https://player.example/old',
      })
    )
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect(harness.addForPage).not.toHaveBeenCalled()
  })

  it('recovers after getAllFrames is briefly unavailable during worker wake', async () => {
    const recoveredFrames: NavigationFrame[] = [
      {
        tabId: 7,
        frameId: 0,
        parentFrameId: -1,
        url: 'https://page.example/watch',
        documentId: 'top-document',
      },
    ]
    const harness = setup({
      frameResults: [new Error('navigation state not ready'), recoveredFrames],
    })

    harness.headersListener()?.(
      response({ documentUrl: undefined, documentId: 'top-document' })
    )
    await vi.waitFor(() => expect(harness.getAllFrames).toHaveBeenCalledOnce())
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(harness.addForPage).not.toHaveBeenCalled()

    harness.headersListener()?.(
      response({ documentUrl: undefined, documentId: 'top-document' })
    )

    await vi.waitFor(() => expect(harness.addForPage).toHaveBeenCalledOnce())
    expect(harness.getAllFrames).toHaveBeenCalledTimes(2)
  })

  it('prefers the Promise-based browser namespace when Firefox also exposes chrome', () => {
    const globals = globalThis as unknown as {
      browser?: unknown
      chrome?: unknown
    }
    const originalBrowser = { ...extensionBrowser }
    const originalChrome = globals.chrome
    const browserAddListener = vi.fn()
    const chromeAddListener = vi.fn()

    Object.assign(extensionBrowser, {
      tabs: { get: vi.fn(async () => ({})) },
      webRequest: {
        onHeadersReceived: {
          addListener: browserAddListener,
          removeListener: vi.fn(),
        },
      },
    })
    globals.chrome = {
      tabs: {
        get: vi.fn((_tabId: number, callback: () => void) => callback()),
      },
      webRequest: {
        onHeadersReceived: {
          addListener: chromeAddListener,
          removeListener: vi.fn(),
        },
      },
    }

    try {
      const unregister = registerNetworkMediaCapture({
        store: {
          addForPage: vi.fn(async () => undefined),
          clear: vi.fn(async () => undefined),
          retainPage: vi.fn(async () => undefined),
        },
      })

      expect(browserAddListener).toHaveBeenCalledOnce()
      expect(chromeAddListener).not.toHaveBeenCalled()
      unregister()
    } finally {
      Object.assign(
        extensionBrowser,
        { webRequest: undefined },
        originalBrowser
      )
      globals.chrome = originalChrome
    }
  })

  it('fully rolls back request listeners when later registration fails', () => {
    const harness = setup({ failHeadersRegistration: true })

    expect(harness.addSendHeadersListener).toHaveBeenCalledOnce()
    expect(harness.addHeadersListener).toHaveBeenCalledOnce()
    expect(harness.removeSendHeadersListener).toHaveBeenCalledOnce()
    expect(harness.removeHeadersListener).not.toHaveBeenCalled()
    expect(harness.removeCommittedListener).not.toHaveBeenCalled()
    expect(harness.clearAllCredentials).toHaveBeenCalledOnce()

    harness.unregister()
    expect(harness.removeSendHeadersListener).toHaveBeenCalledOnce()
  })

  it('prunes on navigation, clears closed tabs and contains storage errors', async () => {
    const harness = setup({ rejectStore: true })

    expect(() =>
      harness.updatedListener()?.(
        7,
        { url: 'https://page.example/next' },
        { url: 'https://page.example/next' }
      )
    ).not.toThrow()
    expect(() =>
      harness.removedListener()?.(7, { isWindowClosing: false, windowId: 1 })
    ).not.toThrow()
    expect(() => harness.headersListener()?.(response())).not.toThrow()

    await vi.waitFor(() => {
      expect(harness.retainPage).toHaveBeenCalledWith(
        7,
        'https://page.example/next'
      )
      expect(harness.retainCredentials).toHaveBeenCalledWith(
        7,
        'https://page.example/next'
      )
      expect(harness.clear).toHaveBeenCalledWith(7)
      expect(harness.clearCredentials).toHaveBeenCalledWith(7)
    })
  })
})
