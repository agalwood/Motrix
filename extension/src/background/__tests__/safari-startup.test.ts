import { afterEach, expect, it, vi } from 'vitest'
import type { Browser } from '@/shared/browser'

// Use exactly the facade selected by Vite for the Safari artifact.
vi.mock('@/shared/browser', () => import('@/shared/browser.safari'))
vi.mock('@motrix/mdxp/browser', () => import('@motrix/mdxp'))
vi.mock('virtual:motrix-youtube-sniffer-script', () => ({ default: null }))
vi.mock('@/content/sniffer-entry?script&iife', () => ({
  default: 'sniffer.js',
}))
vi.mock('@/content/sniffer-relay?script&iife', () => ({ default: 'relay.js' }))
vi.mock('@/shared/i18n', () => ({
  i18n: { t: (key: string) => key },
  initI18n: async () => undefined,
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
})

it('starts with only Safari APIs, responds to offline UI, and blocks all connection probes', async () => {
  vi.resetModules()
  vi.useFakeTimers()
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() })
  const ok = () => vi.fn(async () => undefined)
  const store = () => ({
    get: vi.fn(async () => ({})),
    set: ok(),
    remove: ok(),
  })
  const browser = {
    runtime: {
      id: 'safari-test',
      getManifest: () => ({ version: '0.1.14' }),
      getURL: (path: string) => `safari-web-extension://safari-test/${path}`,
      sendMessage: ok(),
      onMessage: event(),
      onConnect: event(),
    },
    storage: { local: store(), session: store(), onChanged: event() },
    tabs: {
      query: vi.fn(async () => []),
      onUpdated: event(),
      onRemoved: event(),
    },
    contextMenus: {
      remove: ok(),
      removeAll: ok(),
      create: vi.fn(),
      update: ok(),
      onClicked: event(),
    },
    action: {
      setBadgeText: ok(),
      setBadgeBackgroundColor: ok(),
      setBadgeTextColor: ok(),
      setTitle: ok(),
      setIcon: ok(),
    },
    alarms: { create: ok(), clear: ok(), onAlarm: event() },
    i18n: { getUILanguage: () => 'en-US' },
  }
  const fetch = vi.fn()
  const WebSocket = vi.fn()
  vi.stubGlobal('__BROWSER__', 'safari')
  vi.stubGlobal('browser', browser)
  vi.stubGlobal('chrome', undefined)
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('WebSocket', WebSocket)
  await import('@/background/service-worker')
  const listener = browser.runtime.onMessage.addListener.mock
    .calls[0]?.[0] as Parameters<
    typeof Browser.runtime.onMessage.addListener
  >[0]
  const dispatch = (kind: string, payload: unknown = undefined) => {
    const reply = vi.fn()
    expect(
      listener(
        { kind, payload },
        { id: browser.runtime.id, url: browser.runtime.getURL('popup.html') },
        reply
      )
    ).toBe(true)
    return reply
  }
  const state = dispatch('bg.getState')
  const settings = dispatch('bg.getTakeoverConfig')
  const pairing = dispatch('bg.getPairingStatus', { endpointId: 'local' })
  const reconnect = dispatch('bg.reconnect')
  const candidates = dispatch('bg.listPairCandidates')
  const diagnostics = dispatch('bg.runConnectionDiagnostics', {
    endpointId: null,
  })
  const scan = dispatch('bg.scanActiveTab')
  await vi.advanceTimersByTimeAsync(0)
  expect(state).toHaveBeenCalledWith(
    expect.objectContaining({ state: 'disconnected' })
  )
  expect(settings).toHaveBeenCalledOnce()
  expect(pairing).toHaveBeenCalledWith({ paired: false })
  expect(scan).toHaveBeenCalledWith({ media: [], selectionKinds: ['direct'] })
  for (const reply of [reconnect, candidates, diagnostics]) {
    expect(reply).toHaveBeenCalledWith({
      error: 'Safari preview does not support backend connections',
    })
  }
  expect(browser.contextMenus.remove).toHaveBeenCalledWith(
    'motrix.takeover.download'
  )
  expect(browser.contextMenus.update).not.toHaveBeenCalled()
  expect(browser.contextMenus.create).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
  expect(WebSocket).not.toHaveBeenCalled()
})
