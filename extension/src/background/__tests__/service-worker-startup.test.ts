import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Browser } from '@/shared/browser'
import { type DetectedMedia, mediaTabStorageKey } from '@/shared/media'

declare const browser: typeof Browser

// setup.ts installs the Node RAL; the browser-only entry is verified by
// ral-install.test.ts and the production build.
vi.mock('@motrix/mdxp/browser', () => import('@motrix/mdxp'))

// Build-time script paths; executeScript itself is a browser boundary.
vi.mock('virtual:motrix-youtube-sniffer-script', () => ({ default: null }))
vi.mock('@/content/sniffer-entry?script&iife', () => ({
  default: 'sniffer.js',
}))
vi.mock('@/content/sniffer-relay?script&iife', () => ({ default: 'relay.js' }))
// Localization is independent of endpoint readiness; avoid changing the
// process-wide React/i18next singleton on each simulated worker wake.
vi.mock('@/shared/i18n', () => ({
  i18n: { t: (key: string) => key },
  initI18n: async () => undefined,
}))

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const originalBrowser = browser
const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() })
const ok = () => vi.fn(async () => undefined)

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubGlobal('__BROWSER__', 'chromium')
  const browser = {
    ...originalBrowser,
    runtime: {
      ...originalBrowser.runtime,
      getManifest: () => ({ version: '0.1.14' }),
      getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
      sendMessage: ok(),
      onMessage: event(),
      onConnect: event(),
    },
    storage: {
      ...originalBrowser.storage,
      local: { get: vi.fn(async () => ({})), set: ok(), remove: ok() },
      onChanged: event(),
    },
    tabs: {
      query: vi.fn(async () => []),
      onUpdated: event(),
      onRemoved: event(),
    },
    contextMenus: {
      removeAll: ok(),
      create: vi.fn(),
      update: ok(),
      onClicked: event(),
    },
    downloads: { onDeterminingFilename: event() },
    action: {
      setBadgeText: ok(),
      setBadgeBackgroundColor: ok(),
      setBadgeTextColor: ok(),
      setTitle: ok(),
      setIcon: ok(),
    },
    alarms: { create: ok(), clear: ok(), onAlarm: event() },
  }
  vi.stubGlobal('browser', browser)
  vi.stubGlobal('chrome', browser)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
})

function dispatch(
  kind: string,
  payload: unknown = undefined,
  sender: Browser.runtime.MessageSender = {
    id: browser.runtime.id,
    url: browser.runtime.getURL('popup.html'),
  }
) {
  const listener = vi.mocked(browser.runtime.onMessage.addListener).mock
    .calls[0]?.[0]
  if (!listener) throw new Error('background listener not registered')
  const response = vi.fn()
  const keepAlive = listener({ kind, payload }, sender, response)
  expect(keepAlive).toBe(true)
  return response
}

describe('service-worker startup dispatch', () => {
  it('answers popup and options requests while the 30-second autostart is still pending', async () => {
    const { ConnectionManager } = await import('@/background/ConnectionManager')
    const autostart = vi
      .spyOn(ConnectionManager.prototype, 'autostart')
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 30_000))
      )
    await import('@/background/service-worker')
    const state = dispatch('bg.getState')
    const settings = dispatch('bg.getTakeoverConfig')

    await vi.advanceTimersByTimeAsync(0)
    expect(autostart).toHaveBeenCalledOnce()
    const earlyState = state.mock.calls.slice()
    const earlySettings = settings.mock.calls.slice()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(state).toHaveBeenCalledOnce()
    expect(earlyState).toEqual([
      [expect.objectContaining({ state: 'disconnected' })],
    ])
    expect(earlySettings).toHaveLength(1)
  })

  it('registers listeners immediately but keeps recovery ahead of both messages and autostart', async () => {
    const removal = deferred()
    const cleanup = deferred()
    vi.mocked(browser.storage.local.remove).mockReturnValue(removal.promise)
    const { EndpointCatalogService } = await import(
      '@/background/EndpointCatalogService'
    )
    const recover = vi
      .spyOn(EndpointCatalogService.prototype, 'recoverPendingCleanup')
      .mockReturnValue(cleanup.promise)
    const { ConnectionManager } = await import('@/background/ConnectionManager')
    const autostart = vi
      .spyOn(ConnectionManager.prototype, 'autostart')
      .mockResolvedValue()
    await import('@/background/service-worker')
    const response = dispatch('bg.getState')
    expect(
      browser.downloads.onDeterminingFilename.addListener
    ).toHaveBeenCalledOnce()
    expect(browser.contextMenus.onClicked.addListener).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(0)
    expect(response).not.toHaveBeenCalled()
    expect(recover).not.toHaveBeenCalled()
    expect(autostart).not.toHaveBeenCalled()

    removal.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(recover).toHaveBeenCalledOnce()
    expect(response).not.toHaveBeenCalled()
    expect(autostart).not.toHaveBeenCalled()
    cleanup.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(autostart).toHaveBeenCalledOnce()
    expect(response).toHaveBeenCalledOnce()
  })

  it('keeps messages available after an unexpected autostart rejection', async () => {
    const connection = deferred()
    const { ConnectionManager } = await import('@/background/ConnectionManager')
    vi.spyOn(ConnectionManager.prototype, 'autostart').mockReturnValue(
      connection.promise
    )
    await import('@/background/service-worker')
    connection.reject(new Error('connection setup failed'))
    await vi.advanceTimersByTimeAsync(0)
    const response = dispatch('bg.getState')
    await vi.advanceTimersByTimeAsync(0)
    expect(response).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'disconnected' })
    )
  })

  it('accepts content media reports and scans while autostart never settles', async () => {
    const { ConnectionManager } = await import('@/background/ConnectionManager')
    vi.spyOn(ConnectionManager.prototype, 'autostart').mockReturnValue(
      new Promise(() => {})
    )
    const tab = { id: 7, url: 'https://example.com/watch', title: 'Watch' }
    browser.tabs.get = vi.fn(async () => tab as Browser.tabs.Tab)
    vi.mocked(browser.tabs.query).mockResolvedValue([tab as Browser.tabs.Tab])
    browser.scripting = {
      executeScript: ok(),
    } as unknown as typeof Browser.scripting
    await import('@/background/service-worker')
    const media: DetectedMedia = {
      url: 'https://example.com/video.mp4',
      pageUrl: tab.url,
      kind: 'direct',
      pageTitle: tab.title,
      detectedAt: Date.now(),
    }
    const report = dispatch(
      'bg.mediaDetected',
      { tabUrl: tab.url, items: [media] },
      {
        id: browser.runtime.id,
        tab: tab as Browser.tabs.Tab,
        url: tab.url,
        frameId: 0,
      }
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(report).toHaveBeenCalledWith({ ok: true })
    expect(
      await browser.storage.session.get(mediaTabStorageKey(tab.id))
    ).toEqual({
      [mediaTabStorageKey(tab.id)]: [
        expect.objectContaining({ url: media.url }),
      ],
    })
    const scan = dispatch('bg.scanActiveTab')
    await vi.advanceTimersByTimeAsync(75)
    expect(scan).toHaveBeenCalledWith({
      media: [expect.objectContaining({ url: media.url })],
      selectionKinds: ['direct'],
    })
  })

  it.each(['purge', 'cleanup'])(
    'fails closed on %s failure and suppresses autostart',
    async (stage) => {
      const { ConnectionManager } = await import(
        '@/background/ConnectionManager'
      )
      const autostart = vi
        .spyOn(ConnectionManager.prototype, 'autostart')
        .mockResolvedValue()
      const { EndpointCatalogService } = await import(
        '@/background/EndpointCatalogService'
      )
      const fail = async () => {
        throw new Error('storage unavailable')
      }
      if (stage === 'purge')
        vi.mocked(browser.storage.local.remove).mockImplementation(fail)
      else
        vi.spyOn(
          EndpointCatalogService.prototype,
          'recoverPendingCleanup'
        ).mockImplementation(fail)
      await import('@/background/service-worker')
      const response = dispatch('bg.getState')
      await vi.advanceTimersByTimeAsync(0)
      expect(response).toHaveBeenCalledWith({
        error: 'background startup unavailable',
      })
      expect(autostart).not.toHaveBeenCalled()
    }
  )
})
