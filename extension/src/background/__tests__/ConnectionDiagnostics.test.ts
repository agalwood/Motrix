import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createConnectionDiagnosticsHandler,
  nativeHostFailure,
  runConnectionDiagnostics,
} from '@/background/ConnectionDiagnostics'
import type { EndpointConfig } from '@/background/EndpointConfigStore'
import { log } from '@/background/log'
import {
  NativeBootstrap,
  NativeBootstrapError,
} from '@/background/NativeBootstrap'
import type { Browser } from '@/shared/browser'
import { LOG_LEVEL_KEY } from '@/shared/logLevel'

const local: EndpointConfig = {
  version: 3,
  activeEndpointId: 'local',
  servers: [],
  cleanupTombstones: [],
}
const document = {
  app: 'motrix-bridge',
  apiVersion: 1,
  instanceId: 'private-instance',
  appVersion: '2.0.0',
  runtime: 'electron',
  extensionPairing: { protocol: 'mbp1', versions: [1] },
  applicationProtocols: { mdxp: ['1.0'] },
}
const sender = {
  id: 'test-extension-id',
  url: 'chrome-extension://test-extension-id/popup.html',
}
const deps = () => ({
  getConfig: vi.fn(async () => local),
  getPairingStatus: vi.fn(async () => ({ paired: true })),
})
const find = (
  result: Awaited<ReturnType<typeof runConnectionDiagnostics>>,
  id: string
) => result.checks.find((check) => check.id === id)!

beforeEach(() => {
  vi.mocked(browser.runtime.getURL).mockImplementation(
    (path) => `chrome-extension://test-extension-id/${path}`
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(document))
  )
  Object.defineProperty(browser, 'management', {
    configurable: true,
    value: { getSelf: vi.fn(async () => ({ installType: 'development' })) },
  })
  vi.spyOn(NativeBootstrap.prototype, 'discover').mockResolvedValue({
    wsPort: 16900,
    protocolVersion: 1,
    nonce: 'private-nonce',
    nmTicket: { secret: 'private-ticket' },
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(browser, 'management')
  log.setLevel('info')
  vi.useRealTimers()
})

describe('connection diagnostics', () => {
  it('disconnects an unresponsive native host after four seconds', async () => {
    vi.useFakeTimers()
    vi.mocked(NativeBootstrap.prototype.discover).mockRestore()
    const port = {
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
    }
    vi.mocked(browser.runtime.connectNative).mockReturnValue(
      port as unknown as Browser.runtime.Port
    )
    const task = runConnectionDiagnostics(deps(), 'local')
    await vi.advanceTimersByTimeAsync(4001)
    expect(find(await task, 'native-host').detail).toContain('4 seconds')
    expect(port.disconnect).toHaveBeenCalledOnce()
    expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({
      action: 'start',
      allowLaunch: false,
    })
  })
  it('enables debug, identifies unpacked installation, probes standard and host ports without pairing or launching', async () => {
    const dependency = deps()
    const result = await runConnectionDiagnostics(dependency, 'local')
    expect(browser.storage.local.set).toHaveBeenCalledWith({
      [LOG_LEVEL_KEY]: 'debug',
    })
    expect(find(result, 'installation').detail).toContain(
      'installType=development'
    )
    expect(find(result, 'installation').status).toBe('warn')
    expect(find(result, 'extension-allowlist').detail).toContain(
      'chrome-extension://test-extension-id/'
    )
    expect(NativeBootstrap.prototype.discover).toHaveBeenCalledExactlyOnceWith({
      allowLaunch: false,
    })
    expect(fetch).toHaveBeenCalledTimes(6)
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:16900/discovery',
      expect.objectContaining({
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
      })
    )
    expect(find(result, 'local-summary').status).toBe('pass')
    expect(JSON.stringify(result)).not.toMatch(
      /private-(nonce|ticket|instance)/
    )
    expect(dependency.getPairingStatus).toHaveBeenCalledWith('local')
  })

  it('reports a packaged install separately from the build variant', async () => {
    vi.mocked(browser.management.getSelf).mockResolvedValue({
      installType: 'normal',
    } as Browser.management.ExtensionInfo)
    expect(
      find(await runConnectionDiagnostics(deps(), 'local'), 'installation')
        .detail
    ).toContain('unpackedDevelopmentInstall=false')
  })

  it('uses Firefox extension ID, not its runtime UUID, for the native allowlist', async () => {
    vi.mocked(browser.runtime.getURL).mockReturnValue(
      'moz-extension://random-runtime-uuid/'
    )
    const result = await runConnectionDiagnostics(deps(), 'local')
    expect(find(result, 'extension-allowlist').detail).toContain(
      'allowed_extensions must include "test-extension-id"'
    )
    expect(find(result, 'extension-allowlist').detail).not.toContain(
      'random-runtime-uuid'
    )
  })

  it('continues independent checks after an unavailable management API, permission denial and native-host failure', async () => {
    Reflect.deleteProperty(browser, 'management')
    vi.mocked(browser.permissions.contains).mockResolvedValueOnce(false)
    vi.mocked(NativeBootstrap.prototype.discover).mockRejectedValue(
      new Error('Access to the specified native messaging host is forbidden.')
    )
    const result = await runConnectionDiagnostics(deps(), 'local')
    expect(find(result, 'installation').detail).toContain('installType=unknown')
    expect(find(result, 'loopback-permission').status).toBe('fail')
    expect(find(result, 'native-host').detail).toContain(
      'browser denied native-host access'
    )
    expect(find(result, 'local-summary').status).toBe('pass')
  })

  it('distinguishes incompatible discovery and port conflicts without copying response bodies', async () => {
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (String(url).includes(':16802/'))
        return Response.json({
          ...document,
          extensionPairing: { protocol: 'mbp1', versions: [2] },
        })
      if (String(url).includes(':16803/'))
        return new Response('private unrelated server body')
      if (String(url).includes(':16804/'))
        return new Response('private error body', { status: 403 })
      throw new TypeError('Failed to fetch')
    })
    const result = await runConnectionDiagnostics(deps(), 'local')
    expect(find(result, 'discovery:16802').detail).toContain(
      'extensionUpgradeRequired'
    )
    expect(find(result, 'discovery:16803').detail).toContain(
      'Invalid discovery JSON'
    )
    expect(find(result, 'discovery:16804').detail).toContain('HTTP 403')
    expect(find(result, 'local-summary').status).toBe('fail')
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it('bounds local response size', async () => {
    vi.mocked(fetch).mockImplementation(
      async () => new Response('x'.repeat(65537))
    )
    expect(
      find(await runConnectionDiagnostics(deps(), 'local'), 'discovery:16802')
        .detail
    ).toContain('exceeds 64 KiB')
  })

  it('aborts stalled discovery requests and finishes', async () => {
    vi.useFakeTimers()
    vi.mocked(fetch).mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          )
        })
    )
    const task = runConnectionDiagnostics(deps(), 'local')
    await vi.advanceTimersByTimeAsync(1501)
    expect(find(await task, 'discovery:16802').detail).toContain('timed out')
  })

  it('checks only the selected remote route and excludes its private profile data', async () => {
    const dependency = deps()
    dependency.getConfig.mockResolvedValue({
      ...local,
      activeEndpointId: 'server',
      servers: [
        {
          id: 'server',
          name: 'private-name',
          url: 'wss://remote.example/private-path',
          revision: 1,
          state: 'ready',
        },
      ],
    })
    // The production remote adapter verifies response URL; network failure is
    // enough here to assert routing and that no local bootstrap was attempted.
    vi.mocked(fetch).mockRejectedValue(new TypeError('network failure'))
    const result = await runConnectionDiagnostics(dependency, 'server')
    expect(result.backend).toBe('remote')
    expect(find(result, 'native-host').status).toBe('skip')
    expect(NativeBootstrap.prototype.discover).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain(
      'https://remote.example/private-path/discovery'
    )
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it('rejects a stale selection before changing logging or probing', async () => {
    await expect(runConnectionDiagnostics(deps(), 'server')).rejects.toThrow(
      'Selected backend changed'
    )
    expect(browser.storage.local.set).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('marks results stale when the backend changes during a run', async () => {
    const dependency = deps()
    dependency.getConfig
      .mockResolvedValueOnce(local)
      .mockResolvedValue({ ...local, activeEndpointId: 'new' })
    expect(
      find(
        await runConnectionDiagnostics(dependency, 'local'),
        'backend-snapshot'
      ).status
    ).toBe('fail')
  })

  it('rejects content-script senders before side effects and shares duplicate UI runs', async () => {
    const handler = createConnectionDiagnosticsHandler(deps())
    await expect(
      handler(
        { endpointId: 'local' },
        { ...sender, tab: { id: 2 }, url: 'https://example.com' }
      )
    ).rejects.toThrow('diagnostics.forbidden')
    expect(browser.storage.local.set).not.toHaveBeenCalled()
    const first = handler({ endpointId: 'local' }, sender)
    expect(handler({ endpointId: 'local' }, sender)).toBe(first)
    await expect(handler({ endpointId: 'other' }, sender)).rejects.toThrow(
      'already running'
    )
    await first
    expect(NativeBootstrap.prototype.discover).toHaveBeenCalledTimes(1)
  })
})

describe('native-host findings', () => {
  it.each([
    [
      'Specified native messaging host not found.',
      'not found for this browser',
    ],
    ['Failed to start native messaging host.', 'executable permissions'],
    ['NM bootstrap timeout', '4 seconds'],
    ['Native host has exited.', 'does not establish an allowlist problem'],
  ])('classifies %s', (message, advice) => {
    expect(nativeHostFailure(new Error(message)).detail).toContain(advice)
  })
  it('recognizes a stopped App as evidence that the host responded', () => {
    expect(
      nativeHostFailure(
        new NativeBootstrapError('not-running', 'host-error:not-running')
      )
    ).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('Native host answered'),
    })
  })
})
