import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runConnectionDiagnostics } from '@/background/ConnectionDiagnostics'
import { ConnectionManager } from '@/background/ConnectionManager'
import {
  downloadHttpInBrowser,
  handleMenuClick,
} from '@/background/contextMenu/register'
import { extensionBrowser } from '@/shared/browser'
import {
  getBuildBrowser,
  requireProtocolBrowser,
  supportsBackendConnections,
} from '@/shared/browserKind'
import {
  hasNativeMessagingSupport,
  supportsAutoOpenPopup,
  supportsSystemNotifications,
} from '@/shared/platformCapabilities'
import { supportsAutomaticTakeover } from '@/shared/takeoverAvailability'

beforeEach(() => {
  vi.spyOn(extensionBrowser.runtime, 'getManifest').mockReturnValue({
    manifest_version: 3,
    name: 'Motrix Extension',
    version: '0.1.14',
    permissions: [],
  })
  Object.assign(extensionBrowser, {
    action: { openPopup: vi.fn(async () => {}) },
  })
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Safari preview capability boundaries', () => {
  it('requires the popup API even for Safari builds', () => {
    vi.stubGlobal('__BROWSER__', 'safari')
    Object.assign(extensionBrowser.action, { openPopup: undefined })
    expect(supportsAutoOpenPopup('Version/27.0 Safari/627.1')).toBe(false)
  })
  it('enables packaged native connections while retaining Safari API limitations', async () => {
    vi.stubGlobal('__BROWSER__', 'safari')
    vi.spyOn(extensionBrowser.runtime, 'getManifest').mockReturnValue({
      manifest_version: 3,
      name: 'Motrix Extension',
      version: '0.1.14',
      permissions: ['nativeMessaging'],
    })
    const native = vi.spyOn(extensionBrowser.runtime, 'connectNative')
    const message = vi
      .spyOn(extensionBrowser.runtime, 'sendNativeMessage')
      .mockResolvedValue({
        action: 'requestPair',
        protocolVersion: 1,
        port: 16803,
        nonce: 'test-nonce',
      })
    expect(supportsBackendConnections()).toBe(true)
    expect(requireProtocolBrowser('safari')).toBe('safari')
    expect(hasNativeMessagingSupport()).toBe(true)
    expect(supportsAutomaticTakeover({ activeEndpointId: 'local' })).toBe(false)
    expect(supportsSystemNotifications()).toBe(false)
    expect(supportsAutoOpenPopup('Version/27.0 Safari/627.1')).toBe(true)

    const manager = new ConnectionManager({
      clientInfo: {
        kind: 'extension',
        name: 'motrix-extension',
        version: '0.1.14',
        extensionId: 'app.motrix.safari.extension',
        browser: 'safari',
        browserVersion: '27',
        locale: 'en',
      },
    })
    await expect(
      manager.listPairCandidates({ allowLaunch: false })
    ).resolves.toEqual([{ port: 16803, instanceId: null, appVersion: null }])
    expect(message).toHaveBeenCalledExactlyOnceWith('app.motrix.bridge', {
      action: 'bootstrap',
      protocolVersion: 1,
      allowLaunch: false,
      bindingPub: expect.any(String),
    })
    expect(native).not.toHaveBeenCalled()
    manager.stop()
  })
  it('does not advertise host APIs or takeover even when APIs and local settings exist', () => {
    vi.stubGlobal('__BROWSER__', 'safari')
    expect(getBuildBrowser()).toBe('safari')
    expect(hasNativeMessagingSupport()).toBe(false)
    expect(supportsAutomaticTakeover({ activeEndpointId: 'local' })).toBe(false)
    expect(supportsSystemNotifications()).toBe(false)
    expect(supportsAutoOpenPopup('Chrome/151.0')).toBe(true)
    expect(() => requireProtocolBrowser('safari')).toThrow('Safari preview')
    expect(requireProtocolBrowser('chromium')).toBe('chromium')
    expect(requireProtocolBrowser('firefox')).toBe('firefox')
  })

  it('blocks every connection entry before network, discovery or credential access', async () => {
    const fetch = vi.fn()
    const WebSocket = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('WebSocket', WebSocket)
    const native = vi.spyOn(extensionBrowser.runtime, 'connectNative')
    const nativeMessage = vi.spyOn(
      extensionBrowser.runtime,
      'sendNativeMessage'
    )
    const discover = vi.fn()
    const storage = vi.spyOn(extensionBrowser.storage.local, 'get')
    const manager = new ConnectionManager({
      bootstrap: { discover },
      clientInfo: {
        kind: 'extension',
        name: 'motrix-extension',
        version: '0.1.14',
        extensionId: 'safari-test',
        browser: 'safari',
        browserVersion: '27',
        locale: 'en',
      },
    })
    storage.mockClear()
    await manager.autostart()
    await expect(
      manager.connect({ allowLaunch: true, userInitiated: true })
    ).rejects.toThrow('Safari preview')
    await expect(manager.clearGateAndStart()).rejects.toThrow('Safari preview')
    await expect(
      manager.ensureReady({ intent: 'explicit-download' })
    ).rejects.toThrow('Safari preview')
    await expect(
      manager.listPairCandidates({ allowLaunch: true })
    ).rejects.toThrow('Safari preview')
    expect(manager.getState()).toBe('disconnected')
    expect(fetch).not.toHaveBeenCalled()
    expect(WebSocket).not.toHaveBeenCalled()
    expect(native).not.toHaveBeenCalled()
    expect(nativeMessage).not.toHaveBeenCalled()
    expect(discover).not.toHaveBeenCalled()
    expect(storage).not.toHaveBeenCalled()
  })

  it('does not run connection diagnostics or dispatch right-click downloads', async () => {
    vi.stubGlobal('__BROWSER__', 'safari')
    const getConfig = vi.fn()
    await expect(
      runConnectionDiagnostics({ getConfig, getPairingStatus: vi.fn() }, null)
    ).rejects.toThrow('Safari preview')
    expect(getConfig).not.toHaveBeenCalled()
    const run = vi.fn()
    await handleMenuClick(
      {
        menuItemId: 'motrix.takeover.download',
        linkUrl: 'https://example.com/file.zip',
      },
      undefined,
      { getConfig, run }
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('fails explicitly when browser download fallback is absent without navigating', async () => {
    const tabs = vi.spyOn(extensionBrowser.tabs, 'query')
    // The common test host has no downloads API, as on Safari.
    await expect(
      downloadHttpInBrowser('https://example.com/file.zip')
    ).rejects.toThrow('fallback is unavailable')
    expect(tabs).not.toHaveBeenCalled()
  })
})
