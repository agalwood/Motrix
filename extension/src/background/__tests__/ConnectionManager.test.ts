import type { MdxpConnection } from '@motrix/mdxp'
import { ErrorCodes, Methods, Notifications } from '@motrix/mdxp'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionGate } from '@/background/ConnectionGate'
import {
  ConnectionManager,
  type ConnectionManagerOptions,
  type ConnectionState,
} from '@/background/ConnectionManager'
import { EndpointConfigStore } from '@/background/EndpointConfigStore'
import type { BackendAuthority } from '@/background/mbp1/backend-authority'
import {
  type CredentialMutationBoundary,
  CredentialStore,
  type Principal,
  type StoredCredential,
} from '@/background/mbp1/credential-store'
import type { DiscoveryService } from '@/background/mbp1/discovery-service'
import type { PinStore } from '@/background/mbp1/pin-store'
import type {
  NativeBootstrap,
  NativeBootstrapResult,
} from '@/background/NativeBootstrap'
import { TaskEventStore } from '@/background/TaskEventStore'
import type { WebSocketClient } from '@/background/WebSocketClient'

declare const browser: {
  storage: {
    local: {
      get: (k: string | string[]) => Promise<Record<string, unknown>>
      set: (items: Record<string, unknown>) => Promise<void>
      remove: (k: string | string[]) => Promise<void>
    }
  }
}

const CLIENT_INFO: ConnectionManagerOptions['clientInfo'] = {
  name: 'motrix-extension',
  version: '0.1.0',
  extensionId: 'abc',
  browser: 'chromium',
  browserVersion: '120',
  locale: 'en',
}

function remoteServer(id: string, name: string, url: string) {
  return { id, name, url, revision: 0, state: 'ready' as const }
}

function makeUnavailableRemoteDiscoveryService() {
  return {
    discover: vi.fn(async () => ({
      status: 'unavailable' as const,
      reason: 'remoteDiscoveryUnavailable' as const,
      detail: 'networkError' as const,
    })),
    requestNonce: vi.fn(),
  }
}

function makeFakeConn(): MdxpConnection {
  const conn = {
    listen: vi.fn(),
    sendRequest: vi.fn(async (method: string, params: { sentAt?: number }) => {
      if (method === Methods.SystemPing)
        return { sentAt: params.sentAt, recvAt: Date.now() }
      if (method === 'motrix/initialize') {
        const result: Record<string, unknown> = {
          protocolVersion: '1.0',
          server: { name: 'motrix', version: '2.0', runtime: 'electron' },
          capabilities: {
            ffmpegAvailable: true,
            selectionKinds: ['direct'],
            progress: true,
            cancellation: true,
          },
          serverAdapters: [],
        }
        return result
      }
      return undefined
    }),
    sendNotification: vi.fn(),
    onRequest: vi.fn(),
    onNotification: vi.fn(),
    dispose: vi.fn(),
    raw: {} as never,
  }
  return conn as unknown as MdxpConnection
}

function makeFakeConnWithInitializeResult(result: unknown): MdxpConnection {
  const conn = makeFakeConn()
  vi.mocked(conn.sendRequest).mockImplementation(async (method: string) => {
    return (method === Methods.MotrixInitialize ? result : undefined) as never
  })
  return conn
}

interface FakeBootstrapBehavior {
  result?: NativeBootstrapResult
  error?: Error
}

function makeFakeBootstrap(
  ...behaviors: FakeBootstrapBehavior[]
): NativeBootstrap {
  let i = 0
  const fake = {
    discover: vi.fn(async () => {
      const b = behaviors[i] ?? behaviors[behaviors.length - 1]
      i += 1
      if (b?.error) throw b.error
      if (b?.result) return b.result
      throw new Error('no behavior configured')
    }),
  }
  return fake as unknown as NativeBootstrap
}

interface FakeClientBehavior {
  conn?: MdxpConnection
  error?: Error
}

interface FakeClient extends WebSocketClient {
  __triggerClose: () => void
  __urls: string[]
}

function makeFakeClient(...behaviors: FakeClientBehavior[]): FakeClient {
  let i = 0
  let closeCb: (() => void) | null = null
  const urls: string[] = []
  const fake = {
    connect: vi.fn(async (url: string, _sub: string) => {
      urls.push(url)
      const b = behaviors[i] ?? behaviors[behaviors.length - 1]
      i += 1
      if (b?.error) throw b.error
      if (b?.conn) return b.conn
      throw new Error('no behavior configured')
    }),
    onClose: vi.fn((cb: () => void) => {
      closeCb = cb
    }),
    close: vi.fn(),
    getConnection: vi.fn(),
    __triggerClose: () => {
      if (closeCb) closeCb()
    },
    __urls: urls,
  }
  return fake as unknown as FakeClient
}

interface CredentialStoreDoubleOptions {
  recoverOrder?: (principal: Principal) => Promise<StoredCredential[]>
  ageOutUnacked?: (now: number) => Promise<void>
  cleanupFirstPairOrphans?: (principal: Principal, now: number) => Promise<void>
  revokeAll?: (
    principal: Principal,
    beforeDelete?: (ids: readonly string[]) => Promise<void>
  ) => Promise<string[]>
}

/** Test-only structural root whose reads/housekeeping are observable while
 * lifecycle writes still receive a real module-issued nominal facade. */
function makeCredentialStoreDouble(
  options: CredentialStoreDoubleOptions = {}
): CredentialStore {
  const lifecycleRoot = new CredentialStore()
  const recoverOrder = vi.fn(options.recoverOrder ?? (async () => []))
  const ageOutUnacked = vi.fn(options.ageOutUnacked ?? (async () => undefined))
  const cleanupFirstPairOrphans = vi.fn(
    options.cleanupFirstPairOrphans ?? (async () => undefined)
  )
  const revokeAll = vi.fn(options.revokeAll ?? (async () => []))
  return {
    recoverOrder,
    ageOutUnacked,
    cleanupFirstPairOrphans,
    revokeAll,
    forAttempt: vi.fn(
      (authority: BackendAuthority, boundary: CredentialMutationBoundary) =>
        Object.assign(lifecycleRoot.forAttempt(authority, boundary), {
          recoverOrder,
          ageOutUnacked,
          cleanupFirstPairOrphans,
          revokeAll,
        })
    ),
  } as unknown as CredentialStore
}

/**
 * `mode: 'local'` (the default, empty-storage endpoint) now routes through
 * MBP1 (bridge-pairing-protocol.md), not the retired bootstrap transport.
 * With an empty
 * `browser.storage.local` (this file's `beforeEach` resets it every test),
 * `CredentialStore.recoverOrder()` is always empty, so a local connect
 * always takes the first-pair branch — `pairingCodeSource`,
 * `createFrameChannel`, and `createPairingFlow` below exist to make that
 * branch resolve instantly instead of demanding a real §6 PAKE. Its result
 * is handed to `createEnvelopeConnection`, which is the actual seam that
 * decides what `MdxpConnection` the test sees post-handshake — default
 * `mbp1Conn` unless a test passes its own (e.g. a conn that denies pairing,
 * or captures a `$/pair/revoked` handler).
 *
 * `client`/`bootstrap` are unused by this path. First-pair versus reconnect
 * behavior is driven only by `CredentialStore` and is covered in
 * `ConnectionManager.mbp1.test.ts`; the underlying crypto is covered in the
 * pairing/reconnect flow suites.
 *
 * Any other `ConnectionManagerOptions` field (`gate`, `notify`,
 * `initializeTimeoutMs`, …) passes through via `over` untouched, so a test
 * that only cares about generic once-connected machinery can keep using
 * whichever knob it already used before MBP1 existed.
 */
function makeManager(
  over: Partial<ConnectionManagerOptions> & { mbp1Conn?: MdxpConnection } = {}
): ConnectionManager {
  const { mbp1Conn: mbp1ConnOverride, ...rest } = over
  const mbp1Conn = mbp1ConnOverride ?? makeFakeConn()
  const bootstrap =
    rest.bootstrap ??
    makeFakeBootstrap({
      result: { wsPort: 12345, nonce: 'nonce-1' },
    })
  const discoveryService =
    rest.discoveryService ??
    ({
      discoverForReconnect: vi.fn(async () => null),
      discoverForFirstPair: vi.fn(
        async (opts: { allowLaunch: boolean; bindingPub?: Uint8Array }) => {
          const result = await bootstrap.discover({
            allowLaunch: opts.allowLaunch,
            ...(opts.bindingPub === undefined
              ? {}
              : { bindingPub: opts.bindingPub }),
          })
          return [
            {
              transport: 'nm' as const,
              wsPort: result.wsPort,
              compatibility: 'compatible' as const,
              ...(result.nonce === null ? {} : { nonce: result.nonce }),
              ...(result.nmTicket === null
                ? {}
                : { nmTicket: result.nmTicket }),
            },
          ]
        }
      ),
      preflightCompatibility: vi.fn(async (result) => result),
      ensureNonce: vi.fn(async (result) => result),
    } as unknown as DiscoveryService)
  return new ConnectionManager({
    clientInfo: CLIENT_INFO,
    bootstrap,
    client: makeFakeClient({ conn: makeFakeConn() }),
    pairingCodeSource: 'test-code',
    createFrameChannel: () => makeFakeMbp1Channel(),
    createPairingFlow: () => ({
      run: async () => ({
        credentialId: 'fake-credential',
        envelope: {} as never,
        instanceId: 'fake-instance',
      }),
    }),
    createEnvelopeConnection: () => mbp1Conn,
    discoveryService,
    closeReconnectDelayMs: 0,
    ...rest,
  })
}

/** A minimal `Mbp1FrameChannel` for tests whose fake `PairingFlow`/
 *  `ReconnectFlow` never actually drives it — only `release()` is called,
 *  by `finishMbp1Connection`, to hand off a socket the fake conn ignores. */
/**
 * The socket `finishMbp1Connection` gets from `channel.release()`. It only
 * ever calls `addEventListener('close', …)` on it, so that's the only real
 * behavior this fake needs — `fireClose()` lets a test drive the same
 * ws-close → `handleClose` → probe-reconnect path the remote branch already
 * exercises via `client.__triggerClose()`.
 */
class FakeMbp1Socket {
  private closeListeners: Array<() => void> = []
  closeCallCount = 0
  addEventListener(type: string, cb: () => void): void {
    if (type === 'close') this.closeListeners.push(cb)
  }
  removeEventListener(type: string, cb: () => void): void {
    if (type !== 'close') return
    this.closeListeners = this.closeListeners.filter((l) => l !== cb)
  }
  /** `ConnectionManager.stop()`/`enterDenied()` call this directly — it must
   *  not itself fire the 'close' *event* (a real closed-by-us socket does not
   *  loop back through its own listener synchronously the way `fireClose()`
   *  simulates a server-initiated close). */
  close(): void {
    this.closeCallCount += 1
  }
  fireClose(): void {
    for (const cb of this.closeListeners) cb()
  }
}

/** A minimal `Mbp1FrameChannel` for tests whose fake `PairingFlow`/
 *  `ReconnectFlow` never actually drives it — only `release()` is called,
 *  by `finishMbp1Connection`, to hand off a socket the fake conn ignores.
 *  Pass `onRelease` to capture the `FakeMbp1Socket` for a test that needs to
 *  fire a close event on it later. */
function makeFakeMbp1Channel(
  opts: { onRelease?: (socket: FakeMbp1Socket) => void } = {}
): {
  open: () => Promise<void>
  sendText: () => Promise<void>
  receiveText: () => Promise<string>
  sendBinary: () => Promise<void>
  receiveBinary: () => Promise<Uint8Array>
  close: () => void
  release: () => { socket: WebSocket; queuedFrames: Uint8Array[] }
} {
  return {
    open: async () => {},
    sendText: async () => {},
    receiveText: async () => {
      throw new Error('makeFakeMbp1Channel: receiveText should not be called')
    },
    sendBinary: async () => {},
    receiveBinary: async () => {
      throw new Error('makeFakeMbp1Channel: receiveBinary should not be called')
    },
    close: () => {},
    release: () => {
      const socket = new FakeMbp1Socket()
      opts.onRelease?.(socket)
      return { socket: socket as unknown as WebSocket, queuedFrames: [] }
    },
  }
}

beforeEach(() => {
  let backing: Record<string, unknown> = {}
  browser.storage.local.get = vi.fn(async (k: string | string[]) => {
    const keys = Array.isArray(k) ? k : [k]
    const result: Record<string, unknown> = {}
    for (const key of keys) {
      if (key in backing) result[key] = backing[key]
    }
    return result
  })
  browser.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    backing = { ...backing, ...items }
  })
  browser.storage.local.remove = vi.fn(async (k: string | string[]) => {
    const keys = Array.isArray(k) ? k : [k]
    for (const key of keys) delete backing[key]
  })
})

describe('ConnectionManager — happy path', () => {
  it('emits state transitions on first connect', async () => {
    const states: ConnectionState[] = []
    const mgr = makeManager()
    mgr.onStateChange((s) => states.push(s))

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(states).toEqual([
      'bootstrapping',
      'connecting',
      'handshaking',
      'connected',
    ])
  })

  it('captures the backend identity from the initialize handshake', async () => {
    const mgr = makeManager()
    expect(mgr.getServerIdentity()).toBeNull()

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getServerIdentity()).toEqual({
      name: 'motrix',
      version: '2.0',
      runtime: 'electron',
      instanceId: 'fake-instance',
    })
  })

  it('refreshes capabilities on the live session and coalesces concurrent scans', async () => {
    const conn = makeFakeConn()
    const mgr = makeManager({ mbp1Conn: conn })
    await mgr.connect({ allowLaunch: true, userInitiated: true })
    const declared = vi.mocked(conn.sendRequest).mock.calls[0]?.[1]
    const pending = deferred<unknown>()
    vi.mocked(conn.sendRequest).mockImplementationOnce(
      () => pending.promise as never
    )
    const first = mgr.refreshServerCapabilities()
    const second = mgr.refreshServerCapabilities()
    expect(first).toBe(second)
    pending.resolve({
      protocolVersion: '1.0',
      server: { name: 'motrix', version: '2.0', runtime: 'electron' },
      capabilities: {
        ffmpegAvailable: true,
        selectionKinds: ['direct', 'hls', 'dash', 'mux'],
        progress: true,
        cancellation: true,
      },
      serverAdapters: [],
    })
    await expect(first).resolves.toMatchObject({
      selectionKinds: ['direct', 'hls', 'dash', 'mux'],
    })
    expect(conn.sendRequest).toHaveBeenLastCalledWith(
      'motrix/initialize',
      declared
    )
    expect(mgr.getState()).toBe('connected')
    expect(conn.dispose).not.toHaveBeenCalled()
    expect(conn.sendNotification).toHaveBeenCalledTimes(1)
    // A later scan also detects removed/invalidated FFmpeg support.
    vi.mocked(conn.sendRequest).mockResolvedValueOnce({
      protocolVersion: '1.0',
      server: { name: 'motrix', version: '2.0', runtime: 'electron' },
      capabilities: {
        ffmpegAvailable: false,
        selectionKinds: ['direct'],
        progress: true,
        cancellation: true,
      },
      serverAdapters: [],
    } as never)
    await expect(mgr.refreshServerCapabilities()).resolves.toMatchObject({
      ffmpegAvailable: false,
      selectionKinds: ['direct'],
    })
  })

  it('does not connect or launch Motrix to refresh an offline session', async () => {
    const mgr = makeManager()
    await expect(mgr.refreshServerCapabilities()).resolves.toBeNull()
    expect(mgr.getState()).toBe('disconnected')
  })

  it('discards a capability reply after the session is stopped', async () => {
    const conn = makeFakeConn()
    const mgr = makeManager({ mbp1Conn: conn })
    await mgr.connect({ allowLaunch: true, userInitiated: true })
    const pending = deferred<unknown>()
    vi.mocked(conn.sendRequest).mockImplementationOnce(
      () => pending.promise as never
    )
    const refresh = mgr.refreshServerCapabilities()
    mgr.stop()
    pending.resolve({})
    await expect(refresh).rejects.toThrow()
    expect(mgr.getServerCapabilities()).toBeNull()
    expect(mgr.getState()).toBe('disconnected')
  })

  it('bounds capability refresh time and allows another scan after failure', async () => {
    const conn = makeFakeConn()
    const mgr = makeManager({ mbp1Conn: conn, requestTimeoutMs: 10 })
    await mgr.connect({ allowLaunch: true, userInitiated: true })
    vi.mocked(conn.sendRequest).mockImplementationOnce(
      () => new Promise(() => {})
    )
    await expect(mgr.refreshServerCapabilities()).rejects.toThrow('timed out')
    await expect(mgr.refreshServerCapabilities()).resolves.toMatchObject({
      selectionKinds: ['direct'],
    })
  })

  it.each([
    {},
    {
      protocolVersion: '1.0',
      server: { name: 'motrix', version: '2.0', runtime: 'server' },
      capabilities: {
        ffmpegAvailable: true,
        selectionKinds: ['direct', 'mux'],
        progress: true,
        cancellation: true,
      },
      serverAdapters: [],
    },
  ])('rejects an invalid or mismatched refresh reply', async (result) => {
    const conn = makeFakeConn()
    const mgr = makeManager({ mbp1Conn: conn })
    await mgr.connect({ allowLaunch: true, userInitiated: true })
    vi.mocked(conn.sendRequest).mockResolvedValueOnce(result as never)
    await expect(mgr.refreshServerCapabilities()).rejects.toThrow()
    expect(mgr.getServerCapabilities()?.selectionKinds).toEqual(['direct'])
  })

  it('abandons a server that never answers motrix/initialize', async () => {
    const conn = makeFakeConn()
    vi.mocked(conn.sendRequest).mockImplementation(() => new Promise(() => {}))
    const mgr = makeManager({
      mbp1Conn: conn,
      initializeTimeoutMs: 10,
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('disconnected')
    expect(mgr.getLastError()).toMatch(/motrix\/initialize timed out/i)
  })

  // Retired bootstrap-route cases are intentionally absent. Local pairing
  // and reconnect URLs are covered by ConnectionManager.mbp1.test.ts.

  it('sends motrix/initialized notification after handshake', async () => {
    const conn = makeFakeConn()
    const mgr = makeManager({ mbp1Conn: conn })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(conn.sendNotification).toHaveBeenCalledWith(
      'motrix/initialized',
      undefined
    )
  })

  it('ignores a token-era initialize field without reading or writing retired storage', async () => {
    const conn = makeFakeConnWithInitializeResult({
      protocolVersion: '1.0',
      server: { name: 'motrix', version: '2.0', runtime: 'electron' },
      capabilities: {
        ffmpegAvailable: true,
        selectionKinds: ['direct'],
        progress: true,
        cancellation: true,
      },
      serverAdapters: [],
      pairToken: 'secret-sentinel',
    })
    const mgr = makeManager({ mbp1Conn: conn })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('connected')
    for (const [items] of vi.mocked(browser.storage.local.set).mock.calls) {
      expect(items).not.toHaveProperty('motrix.pairTokens')
      expect(items).not.toHaveProperty('motrix.pairToken')
    }
    expect(vi.mocked(browser.storage.local.get).mock.calls).not.toContainEqual([
      'motrix.pairTokens',
    ])
    expect(vi.mocked(browser.storage.local.get).mock.calls).not.toContainEqual([
      'motrix.pairToken',
    ])
  })
})

describe('ConnectionManager — failure paths', () => {
  it.each([
    {
      label: 'a newer MDXP version',
      result: {
        protocolVersion: '2.0',
        server: { name: 'motrix', version: '3.0', runtime: 'electron' },
        capabilities: {
          ffmpegAvailable: true,
          selectionKinds: ['direct'],
          progress: true,
          cancellation: true,
        },
        serverAdapters: [],
      },
      reason: 'extensionUpgradeRequired',
    },
    {
      label: 'a server runtime',
      result: {
        protocolVersion: '1.0',
        server: { name: 'motrix', version: '2.0', runtime: 'server' },
        capabilities: {
          ffmpegAvailable: true,
          selectionKinds: ['direct'],
          progress: true,
          cancellation: true,
        },
        serverAdapters: [],
      },
      reason: 'unsupportedRemote',
    },
  ])(
    'rejects $label from the authenticated initialize result',
    async ({ result, reason }) => {
      const conn = makeFakeConnWithInitializeResult(result)
      const mgr = makeManager({ mbp1Conn: conn })

      await mgr.connect({ allowLaunch: true, userInitiated: true })

      expect(mgr.getState()).toBe('disconnected')
      expect(mgr.getLastErrorReason()).toBe(reason)
      expect(mgr.getServerIdentity()).toBeNull()
      expect(conn.sendNotification).not.toHaveBeenCalledWith(
        Notifications.MotrixInitialized,
        undefined
      )
    }
  )

  // "NM bootstrap failure lands in disconnected — no reconnect storm" and
  // "nonce=null + no cached token fails the single attempt" were removed
  // here: both asserted on the legacy local-endpoint behavior where a
  // `NativeBootstrap.discover()` error/nonce propagated straight into
  // `connectOnce`'s own error message. Under MBP1, `DiscoveryService.
  // tryNativeBootstrap` deliberately swallows a bootstrap error and falls
  // through to a `/discovery` sweep instead (see discovery-service.ts) — a
  // real localhost network sweep is the wrong thing to exercise from this
  // file. The structural property both tests cared about ("first-pair
  // discovery finds nothing usable → one clean failed attempt, disconnected,
  // no reconnect storm") is covered with a fully mocked `discoveryService`
  // in `ConnectionManager.mbp1.test.ts` instead.

  it('WS close after connected triggers one unattended probe-reconnect that refuses to fall back to fresh pairing', async () => {
    // New behavior: handleClose → connect({allowLaunch:false, userInitiated:
    // false}) → single attempt. No 'reconnecting' intermediate state — goes
    // directly disconnected → bootstrapping. The fake `PairingFlow` never
    // writes to `credentialStore`, so this post-close attempt's recovery
    // order is empty; since it is unattended (H1), it must land in
    // disconnected rather than falling back to fresh code-entry pairing — a
    // reconnect that actually authenticates via a stored credential is
    // `ConnectionManager.mbp1.test.ts`'s job.
    const states: ConnectionState[] = []
    const sockets: FakeMbp1Socket[] = []
    const mgr = makeManager({
      createFrameChannel: () =>
        makeFakeMbp1Channel({ onRelease: (s) => sockets.push(s) }),
    })
    mgr.onStateChange((s) => states.push(s))

    await mgr.connect({ allowLaunch: true, userInitiated: true })
    expect(mgr.getState()).toBe('connected')
    expect(sockets).toHaveLength(1)

    const connectSpy = vi.spyOn(mgr, 'connect')
    sockets[0]?.fireClose()
    await new Promise((r) => setTimeout(r, 20))

    // Positive proof the probe-reconnect actually fires, not merely that
    // the outcome looks the same as if `handleClose` never called
    // `connect()` at all — every assertion below would also pass for that
    // (silently broken) version.
    expect(connectSpy).toHaveBeenCalledTimes(1)
    expect(connectSpy).toHaveBeenCalledWith({
      allowLaunch: false,
      userInitiated: false,
    })
    expect(states).not.toContain('reconnecting')
    expect(mgr.getState()).toBe('disconnected')
    // No second pre-auth channel — the empty recovery order never reaches
    // connectFirstPairMbp1 for an unattended attempt.
    expect(sockets).toHaveLength(1)
  })

  it('waits for the bounded restart window before issuing exactly one close probe', async () => {
    const sockets: FakeMbp1Socket[] = []
    const mgr = makeManager({
      closeReconnectDelayMs: 250,
      createFrameChannel: () =>
        makeFakeMbp1Channel({ onRelease: (socket) => sockets.push(socket) }),
    })
    await mgr.connect({ allowLaunch: true, userInitiated: true })
    const connectSpy = vi.spyOn(mgr, 'connect')

    vi.useFakeTimers()
    try {
      sockets[0]?.fireClose()
      expect(connectSpy).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(249)
      expect(connectSpy).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(connectSpy).toHaveBeenCalledTimes(1)
      expect(connectSpy).toHaveBeenCalledWith({
        allowLaunch: false,
        userInitiated: false,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a delayed close probe when the endpoint lifecycle is retired', async () => {
    const sockets: FakeMbp1Socket[] = []
    const mgr = makeManager({
      closeReconnectDelayMs: 250,
      createFrameChannel: () =>
        makeFakeMbp1Channel({ onRelease: (socket) => sockets.push(socket) }),
    })
    await mgr.connect({ allowLaunch: true, userInitiated: true })
    const connectSpy = vi.spyOn(mgr, 'connect')

    vi.useFakeTimers()
    try {
      sockets[0]?.fireClose()
      mgr.stopForEndpointChange()
      await vi.advanceTimersByTimeAsync(250)
      expect(connectSpy).not.toHaveBeenCalled()
      expect(mgr.getState()).toBe('disconnected')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop() while connected transitions to disconnected', async () => {
    // With the new connect() path there is no reconnect timer — a failed
    // single attempt returns 'disconnected' immediately. Verify stop() on
    // a live connection closes the WS and lands in 'disconnected'.
    const conn = makeFakeConn()
    const client = makeFakeClient({ conn })
    const mgr = makeManager({ client })

    await mgr.connect({ allowLaunch: true, userInitiated: true })
    expect(mgr.getState()).toBe('connected')
    expect(mgr.getServerIdentity()).not.toBeNull()

    mgr.stop()

    expect(mgr.getState()).toBe('disconnected')
    expect(mgr.getServerIdentity()).toBeNull()
    expect(client.close).toHaveBeenCalled()
  })

  it('connect() is idempotent — second call while non-disconnected is a no-op', async () => {
    const mgr = makeManager()
    await mgr.connect({ allowLaunch: true, userInitiated: true })
    expect(mgr.getState()).toBe('connected')
    await mgr.connect({ allowLaunch: true, userInitiated: true })
    expect(mgr.getState()).toBe('connected')
  })
})

describe('ConnectionManager — connection gate (SW-restart safety)', () => {
  it('pair attempt marks gate pair-pending before initialize', async () => {
    const gate = new ConnectionGate()
    const mgr = makeManager({ gate })

    await mgr.connect({ allowLaunch: true, userInitiated: true })
    expect(mgr.getState()).toBe('connected')
    // After successful handshake the gate is cleared
    expect((await gate.get()).reason).toBeNull()
  })

  it('connect() respects pair-pending gate and skips connectOnce', async () => {
    const gate = new ConnectionGate()
    await gate.pausePending(60_000)

    const bootstrap = makeFakeBootstrap({
      result: { wsPort: 12345, nonce: 'n' },
    })
    const client = makeFakeClient({ conn: makeFakeConn() })
    const mgr = new ConnectionManager({
      clientInfo: CLIENT_INFO,
      bootstrap,
      client,
      gate,
    })

    await mgr.connect({ allowLaunch: false, userInitiated: false })

    expect(bootstrap.discover).not.toHaveBeenCalled()
    expect(client.__urls).toHaveLength(0)
    expect(mgr.getState()).toBe('disconnected')
  })

  it('connect() respects denied gate and surfaces lastError', async () => {
    const gate = new ConnectionGate()
    await gate.pauseDenied('user denied earlier')

    const mgr = new ConnectionManager({
      clientInfo: CLIENT_INFO,
      bootstrap: makeFakeBootstrap({
        result: { wsPort: 12345, nonce: 'n' },
      }),
      client: makeFakeClient({ conn: makeFakeConn() }),
      gate,
    })

    await mgr.connect({ allowLaunch: false, userInitiated: false })

    expect(mgr.getState()).toBe('denied')
    expect(mgr.getLastError()).toBe('user denied earlier')
  })

  it('clearGateAndStart releases pair-pending and connects', async () => {
    const gate = new ConnectionGate()
    await gate.pausePending(60_000)

    const mgr = makeManager({ gate })

    await mgr.clearGateAndStart()

    expect(mgr.getState()).toBe('connected')
    expect((await gate.get()).reason).toBeNull()
  })
})

describe('ConnectionManager — pair denial', () => {
  function makeConnDeniedOnInit(
    code: number,
    appCode?: string
  ): MdxpConnection {
    const conn = {
      listen: vi.fn(),
      sendRequest: vi.fn(async (method: string) => {
        if (method === 'motrix/initialize') {
          const err = new Error('User denied pairing') as Error & {
            code: number
            data?: { appCode: string }
          }
          err.code = code
          if (appCode !== undefined) err.data = { appCode }
          throw err
        }
        return undefined
      }),
      sendNotification: vi.fn(),
      onRequest: vi.fn(),
      onNotification: vi.fn(),
      dispose: vi.fn(),
      raw: {} as never,
    }
    return conn as unknown as MdxpConnection
  }

  it('enters terminal "denied" state on PermissionDenied — no reconnect', async () => {
    const states: ConnectionState[] = []
    const mgr = makeManager({
      mbp1Conn: makeConnDeniedOnInit(-32003, 'pair.denied'),
    })
    mgr.onStateChange((s) => states.push(s))

    await mgr.connect({ allowLaunch: true, userInitiated: true })
    // Reconnect should NOT fire — wait past any backoff window
    await new Promise((r) => setTimeout(r, 80))

    expect(mgr.getState()).toBe('denied')
    expect(states).not.toContain('reconnecting')
    expect(mgr.getLastError()).toMatch(/denied/i)
  })

  it('enters denied when initialize reports a revoked credential', async () => {
    const mgr = makeManager({
      mbp1Conn: makeConnDeniedOnInit(-32006),
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })
    await new Promise((r) => setTimeout(r, 20))

    expect(mgr.getState()).toBe('denied')
  })

  it('clearGateAndStart from denied retries the connect flow', async () => {
    // First attempt denies, second succeeds via popup-style retry.
    const conns = [makeConnDeniedOnInit(-32003), makeFakeConn()]
    let i = 0
    const mgr = makeManager({
      createEnvelopeConnection: () => conns[i++] ?? conns[conns.length - 1],
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })
    expect(mgr.getState()).toBe('denied')

    // Mimic the popup's Reconnect handler — clears the gate and starts.
    await mgr.clearGateAndStart()
    expect(mgr.getState()).toBe('connected')
    expect(mgr.getLastError()).toBeNull()
  })
})

describe('ConnectionManager — pair revoked notification', () => {
  function makeConnCapturingRevoke(): {
    conn: MdxpConnection
    fireRevoked: (reason: string) => void
  } {
    let revokedHandler: ((p: { reason: string }) => void) | null = null
    const conn = {
      listen: vi.fn(),
      sendRequest: vi.fn(async (method: string) => {
        if (method === 'motrix/initialize') {
          return {
            protocolVersion: '1.0',
            server: { name: 'motrix', version: '2.0', runtime: 'electron' },
            capabilities: {
              ffmpegAvailable: true,
              selectionKinds: ['direct'],
              progress: true,
              cancellation: true,
            },
            serverAdapters: [],
          }
        }
        return undefined
      }),
      sendNotification: vi.fn(),
      onRequest: vi.fn(),
      onNotification: vi.fn((name: string, handler: unknown) => {
        if (name === '$/pair/revoked') {
          revokedHandler = handler as (p: { reason: string }) => void
        }
      }),
      dispose: vi.fn(),
      raw: {} as never,
    }
    return {
      conn: conn as unknown as MdxpConnection,
      fireRevoked: (reason: string) => {
        if (!revokedHandler) throw new Error('revoked handler not registered')
        revokedHandler({ reason })
      },
    }
  }

  it('on $/pair/revoked: enters denied and does not reconnect on ws close', async () => {
    const { conn, fireRevoked } = makeConnCapturingRevoke()
    const states: ConnectionState[] = []
    const sockets: FakeMbp1Socket[] = []
    const mgr = makeManager({
      mbp1Conn: conn,
      createFrameChannel: () =>
        makeFakeMbp1Channel({ onRelease: (s) => sockets.push(s) }),
    })
    mgr.onStateChange((s) => states.push(s))

    await mgr.connect({ allowLaunch: true, userInitiated: true })
    expect(mgr.getState()).toBe('connected')

    // Motrix revokes → notification arrives
    fireRevoked('user-revoked')
    await new Promise((r) => setTimeout(r, 10))

    expect(mgr.getState()).toBe('denied')
    expect(mgr.getLastError()).toMatch(/revoked/i)

    // The ws-close Motrix sends ~50ms later must NOT reconnect
    sockets[0]?.fireClose()
    await new Promise((r) => setTimeout(r, 30))
    expect(states).not.toContain('reconnecting')
    expect(mgr.getState()).toBe('denied')
  })

  it('revokes every MBP1 credential and pin for the current principal', async () => {
    const pinClear = vi.fn(async () => undefined)
    let revokedPrincipal: Principal | null = null
    const revokeAll = vi.fn(
      async (
        principal: Principal,
        beforeDelete?: (ids: readonly string[]) => Promise<void>
      ) => {
        revokedPrincipal = principal
        await beforeDelete?.(['cred-current', 'cred-uncertain'])
        return ['cred-current', 'cred-uncertain']
      }
    )
    const { conn, fireRevoked } = makeConnCapturingRevoke()
    const mgr = makeManager({
      mbp1Conn: conn,
      credentialStore: makeCredentialStoreDouble({
        revokeAll,
      }),
      pinStore: { clear: pinClear } as unknown as PinStore,
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })
    fireRevoked('user-revoked')
    await vi.waitFor(() => expect(revokeAll).toHaveBeenCalledTimes(1))

    expect(revokedPrincipal).toMatchObject({ browser: 'chromium' })
    expect(pinClear).toHaveBeenCalledWith('cred-current')
    expect(pinClear).toHaveBeenCalledWith('cred-uncertain')
  })

  it('blocks an immediate UI retry until revoked credentials are gone', async () => {
    let cleanupComplete = false
    let releaseRevocation!: () => void
    const revocationBlocked = new Promise<void>((resolve) => {
      releaseRevocation = resolve
    })
    const revokeAll = vi.fn(
      async (
        _principal: Principal,
        beforeDelete?: (ids: readonly string[]) => Promise<void>
      ) => {
        await beforeDelete?.(['cred-stale'])
        await revocationBlocked
        cleanupComplete = true
        return ['cred-stale']
      }
    )
    const recoveryObservedCleanup: boolean[] = []
    const recoverOrder = vi.fn(async () => {
      recoveryObservedCleanup.push(cleanupComplete)
      return []
    })
    const discoverForFirstPair = vi.fn(async () => [
      {
        transport: 'probe' as const,
        wsPort: 12345,
        nonce: 'nonce-1',
        compatibility: 'compatible' as const,
      },
    ])
    const pairingRun = vi.fn(async () => ({
      credentialId: 'fake-credential',
      envelope: {} as never,
      instanceId: 'fake-instance',
    }))
    const { conn, fireRevoked } = makeConnCapturingRevoke()
    const mgr = makeManager({
      mbp1Conn: conn,
      credentialStore: makeCredentialStoreDouble({
        recoverOrder,
        revokeAll,
      }),
      pinStore: {
        clear: vi.fn(async () => undefined),
      } as unknown as PinStore,
      discoveryService: {
        discoverForReconnect: vi.fn(async () => null),
        discoverForFirstPair,
        preflightCompatibility: vi.fn(async (result) => result),
        ensureNonce: vi.fn(async (result) => result),
      } as unknown as DiscoveryService,
      createPairingFlow: () => ({ run: pairingRun }),
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })
    recoverOrder.mockClear()
    recoveryObservedCleanup.length = 0
    discoverForFirstPair.mockClear()
    pairingRun.mockClear()
    let retry: Promise<void> | null = null
    mgr.onStateChange((state) => {
      if (state === 'denied' && retry === null) {
        retry = mgr.clearGateAndStart()
      }
    })

    fireRevoked('user-revoked')
    await vi.waitFor(() => expect(revokeAll).toHaveBeenCalledTimes(1))

    // `denied` is observable before asynchronous storage cleanup finishes.
    // The popup may react immediately, but must not reconnect with the
    // credential that Motrix has just revoked.
    expect(mgr.getState()).toBe('denied')
    expect(retry).not.toBeNull()
    expect(recoverOrder).not.toHaveBeenCalled()
    expect(discoverForFirstPair).not.toHaveBeenCalled()
    expect(pairingRun).not.toHaveBeenCalled()

    releaseRevocation()
    await retry

    expect(recoveryObservedCleanup).toEqual([true])
    expect(discoverForFirstPair).toHaveBeenCalledTimes(1)
    expect(pairingRun).toHaveBeenCalledTimes(1)
    expect(mgr.getState()).toBe('connected')
  })

  it('fires a reminder notification on $/pair/revoked', async () => {
    const notify = vi.fn()
    const { conn, fireRevoked } = makeConnCapturingRevoke()
    const mgr = makeManager({ mbp1Conn: conn, notify })
    await mgr.connect({ allowLaunch: true, userInitiated: true })
    fireRevoked('user-revoked')
    await new Promise((r) => setTimeout(r, 10))
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'reminder', kind: 'pairing.revoked' })
    )
  })

  it('lastError is set BEFORE the denied state fires (UI sees revoke reason)', async () => {
    // Regression: handlePairRevoked used to assign lastErrorMessage after
    // enterDenied, so a state listener reading getLastError() during the
    // 'denied' transition saw stale (null/prior) error text.
    const { conn, fireRevoked } = makeConnCapturingRevoke()
    const mgr = makeManager({ mbp1Conn: conn })

    let errorAtDeniedTransition: string | null | undefined
    mgr.onStateChange((s) => {
      if (s === 'denied' && errorAtDeniedTransition === undefined) {
        errorAtDeniedTransition = mgr.getLastError()
      }
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })
    fireRevoked('user-revoked')
    await new Promise((r) => setTimeout(r, 10))

    expect(errorAtDeniedTransition).toMatch(/revoked/i)
    expect(errorAtDeniedTransition).toContain('user-revoked')
  })
})

// ---------------------------------------------------------------------------
// Helpers for Task-5 tests
// ---------------------------------------------------------------------------

/** Drain the microtask queue (lets void-async chains settle). */
async function flush(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0))
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ---------------------------------------------------------------------------
// Task-5 test suite
// ---------------------------------------------------------------------------

describe('ConnectionManager — user-intent connect + single probe-reconnect', () => {
  it('connect({allowLaunch:true}) passes allowLaunch to discover', async () => {
    // `discover` here is `NativeBootstrap.discover`, still reached indirectly
    // through `DiscoveryService`'s NM-bootstrap adapter for a local (MBP1)
    // first-pair attempt (see `makeManager`'s doc comment).
    const discover = vi.fn(async () => ({ wsPort: 12345, nonce: 'n' }))
    const mgr = makeManager({ bootstrap: { discover } as never })
    await mgr.connect({ allowLaunch: true, userInitiated: true })
    expect(discover).toHaveBeenCalledWith({
      allowLaunch: true,
      bindingPub: expect.any(Uint8Array),
    })
    expect(mgr.getState()).toBe('connected')
  })

  it('autostart() stays dormant with no committed credential', async () => {
    const discover = vi.fn()
    const mgr = new ConnectionManager({
      clientInfo: CLIENT_INFO,
      bootstrap: { discover } as never,
      client: makeFakeClient({ conn: makeFakeConn() }),
    })
    await mgr.autostart()
    expect(discover).not.toHaveBeenCalled()
    expect(mgr.getState()).toBe('disconnected')
  })

  // A reconnect with an existing MBP1 credential
  // probes via `DiscoveryService.discoverForReconnect` (a `/discovery`
  // sweep / pinned-port probe) — it never calls `NativeBootstrap.discover`
  // at all, so asserting on `discover` no longer tests what actually runs.
  // Covered instead in `ConnectionManager.mbp1.test.ts` with a mocked
  // `discoveryService`.

  it('WS close while connected does not fall back to fresh pairing when unattended', async () => {
    // The fake `PairingFlow` never actually writes to `credentialStore`, so
    // the post-close attempt's recovery order is empty. Before H1's fix
    // this fell through to a second first-pair via `NativeBootstrap.
    // discover`, same as the initial connect; an unattended attempt must
    // now refuse and land in `disconnected` instead of reaching it again.
    const discover = vi.fn(async () => ({ wsPort: 12345, nonce: 'n' }))
    const sockets: FakeMbp1Socket[] = []
    const mgr = makeManager({
      bootstrap: { discover } as never,
      createFrameChannel: () =>
        makeFakeMbp1Channel({ onRelease: (s) => sockets.push(s) }),
    })
    await mgr.connect({ allowLaunch: true, userInitiated: true }) // 1st discover
    expect(sockets).toHaveLength(1)
    expect(discover).toHaveBeenCalledTimes(1)

    const connectSpy = vi.spyOn(mgr, 'connect')
    sockets[0]?.fireClose()
    await flush()
    // Positive proof `handleClose` actually re-invoked `connect()` — see the
    // sibling probe-reconnect test above for why `discover`'s own call
    // count alone can't tell "refused correctly" apart from "never ran".
    expect(connectSpy).toHaveBeenCalledTimes(1)
    expect(connectSpy).toHaveBeenCalledWith({
      allowLaunch: false,
      userInitiated: false,
    })
    expect(discover).toHaveBeenCalledTimes(1) // no second first-pair attempt
    expect(mgr.getState()).toBe('disconnected')
  })

  // A local reconnect's credential-invalidation decision is made
  // per `ReconnectFlowError.reason` (see reconnect-flow.ts's own docstrings
  // and reconnect-flow.test.ts — e.g. `authFailed` advances the recovery
  // walk, `serverMacMismatch` does not delete the credential), and remote
  // mode never had a "fresh nonce" signal to begin with.

  it('releases the local MBP1 socket before the unattended probe-reconnect', async () => {
    const client = makeFakeClient()
    const sockets: FakeMbp1Socket[] = []
    const mgr = makeManager({
      client,
      createFrameChannel: () =>
        makeFakeMbp1Channel({ onRelease: (socket) => sockets.push(socket) }),
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })
    expect(mgr.getState()).toBe('connected')
    sockets[0]?.fireClose()
    await flush()

    expect(client.close).toHaveBeenCalled()
    expect(sockets[0]?.closeCallCount).toBeGreaterThan(0)
    expect(mgr.getState()).toBe('disconnected')
  })

  it('a compatibility failure does not poison a later compatible attempt', async () => {
    let attempt = 0
    const discoveryService = {
      discoverForReconnect: vi.fn(async () => null),
      discoverForFirstPair: vi.fn(async () => {
        attempt += 1
        return [
          {
            transport: 'probe' as const,
            wsPort: 16802,
            compatibility:
              attempt === 1
                ? ('backendUpgradeRequired' as const)
                : ('compatible' as const),
          },
        ]
      }),
      preflightCompatibility: vi.fn(async (result) => result),
      ensureNonce: vi.fn(async (result) => ({ ...result, nonce: 'n' })),
    } as unknown as DiscoveryService
    const mgr = makeManager({ discoveryService })

    await mgr.clearGateAndStart()
    expect(mgr.getState()).toBe('disconnected')
    expect(mgr.getLastErrorReason()).toBe('backendUpgradeRequired')

    await mgr.clearGateAndStart()
    expect(mgr.getState()).toBe('connected')
  })
})

describe('ConnectionManager — request() proxy', () => {
  it('request() forwards to the live connection when connected', async () => {
    // Build a fake conn whose sendRequest records calls and returns canned results
    const cannedResult = { tasks: [], total: 0 }
    const fakeConn: MdxpConnection = {
      listen: vi.fn(),
      sendRequest: vi.fn(async (method: string) => {
        if (method === 'motrix/initialize') {
          return {
            protocolVersion: '1.0',
            server: { name: 'motrix', version: '2.0', runtime: 'electron' },
            capabilities: {
              ffmpegAvailable: true,
              selectionKinds: ['direct'],
              progress: true,
              cancellation: true,
            },
            serverAdapters: [],
          }
        }
        if (method === 'task/list') return cannedResult
        return undefined
      }),
      sendNotification: vi.fn(),
      onRequest: vi.fn(),
      onNotification: vi.fn(),
      dispose: vi.fn(),
      raw: {} as never,
    } as unknown as MdxpConnection

    const manager = makeManager({ mbp1Conn: fakeConn })

    // Drive the manager to 'connected'
    await manager.connect({ allowLaunch: true, userInitiated: true })
    expect(manager.getState()).toBe('connected')

    const result = await manager.request('task/list', { limit: 10 })
    expect(fakeConn.sendRequest).toHaveBeenCalledWith(
      'task/list',
      {
        limit: 10,
      },
      expect.objectContaining({ isCancellationRequested: false })
    )
    expect(result).toEqual(cannedResult)
  })

  it('request() throws when not connected', async () => {
    // manager starts in 'disconnected' state
    const manager = makeManager()
    expect(manager.getState()).toBe('disconnected')
    await expect(manager.request('task/list', {})).rejects.toThrow(
      /not connected/i
    )
  })
})

describe('ConnectionManager — remote endpoint', () => {
  it('does not read retired token storage for obsolete endpoint data', async () => {
    await browser.storage.local.set({
      'motrix.endpointConfig': {
        mode: 'remote',
        remoteUrl: 'wss://legacy-server.example',
      },
      'motrix.pairToken': 'tok-legacy-app',
    })
    const endpointConfigStore = new EndpointConfigStore()
    const client = makeFakeClient({ conn: makeFakeConn() })
    const mgr = new ConnectionManager({
      clientInfo: CLIENT_INFO,
      bootstrap: makeFakeBootstrap({
        error: new Error('NM should not be called in remote mode'),
      }),
      client,
      endpointConfigStore,
      remoteDiscoveryService: makeUnavailableRemoteDiscoveryService(),
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('disconnected')
    expect(client.__urls).toEqual([])
    const storageReads = vi.mocked(browser.storage.local.get).mock.calls
    expect(storageReads).not.toContainEqual(['motrix.pairToken'])
    expect(storageReads).not.toContainEqual(['motrix.pairTokens'])
  })

  it('keeps every configured remote backend behind the compatibility boundary', async () => {
    const endpointConfigStore = new EndpointConfigStore()
    const servers = [
      remoteServer('server-a', 'Server A', 'wss://motrix.example/bridge'),
      remoteServer('server-b', 'Server B', 'wss://nas.local:9090'),
    ]
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'local',
      servers,
      cleanupTombstones: [],
    })
    const client = makeFakeClient(
      { conn: makeFakeConn() },
      { conn: makeFakeConn() }
    )
    const mgr = new ConnectionManager({
      clientInfo: CLIENT_INFO,
      bootstrap: makeFakeBootstrap(
        { result: { wsPort: 16800, nonce: 'local-nonce-1' } },
        { result: { wsPort: 16800, nonce: 'local-nonce-2' } }
      ),
      client,
      endpointConfigStore,
      remoteDiscoveryService: makeUnavailableRemoteDiscoveryService(),
      // MBP1 seams for the local ("App") legs — credentialStore stays empty
      // across both visits (the fake PairingFlow never writes one), so each
      // one is a fresh first-pair via /pair?nonce=, never a reconnect.
      pairingCodeSource: 'test-code',
      createFrameChannel: () => makeFakeMbp1Channel(),
      createPairingFlow: () => ({
        run: async () => ({
          credentialId: 'fake-credential',
          envelope: {} as never,
          instanceId: 'fake-instance',
        }),
      }),
      createEnvelopeConnection: () => makeFakeConn(),
    })
    const localUrls: string[] = []

    await mgr.connect({ allowLaunch: true, userInitiated: true })
    localUrls.push(mgr.lastConnectUrl ?? '')
    mgr.stop()
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'server-a',
      servers,
      cleanupTombstones: [],
    })
    await mgr.connect({ allowLaunch: true, userInitiated: true })
    expect(mgr.getLastErrorReason()).toBe('remoteDiscoveryUnavailable')
    mgr.stop()
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'server-b',
      servers,
      cleanupTombstones: [],
    })
    await mgr.connect({ allowLaunch: true, userInitiated: true })
    expect(mgr.getLastErrorReason()).toBe('remoteDiscoveryUnavailable')
    mgr.stop()
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'local',
      servers,
      cleanupTombstones: [],
    })
    await mgr.connect({ allowLaunch: true, userInitiated: true })
    localUrls.push(mgr.lastConnectUrl ?? '')

    expect(client.__urls).toEqual([])
    expect(localUrls).toEqual(['', ''])
  })

  it('discovers a remote URL without native bootstrap or legacy socket creation', async () => {
    const endpointConfigStore = new EndpointConfigStore()
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'nas',
      servers: [remoteServer('nas', 'NAS', 'wss://nas.local:9090')],
      cleanupTombstones: [],
    })

    const bootstrap = makeFakeBootstrap({
      error: new Error('NM should not be called in remote mode'),
    })
    const client = makeFakeClient({ conn: makeFakeConn() })
    const mgr = new ConnectionManager({
      clientInfo: CLIENT_INFO,
      bootstrap,
      client,
      endpointConfigStore,
      remoteDiscoveryService: makeUnavailableRemoteDiscoveryService(),
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('disconnected')
    expect(mgr.getLastErrorReason()).toBe('remoteDiscoveryUnavailable')
    expect(bootstrap.discover).not.toHaveBeenCalled()
    expect(client.__urls).toEqual([])
  })

  it('does not open a websocket when secure remote discovery is unavailable', async () => {
    const endpointConfigStore = new EndpointConfigStore()
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'secure',
      servers: [
        remoteServer('secure', 'Secure', 'wss://MOTRIX.example:443/bridge/'),
      ],
      cleanupTombstones: [],
    })
    const bootstrap = makeFakeBootstrap({
      error: new Error('NM should not be called in remote mode'),
    })
    const client = makeFakeClient({ conn: makeFakeConn() })
    const mgr = new ConnectionManager({
      clientInfo: CLIENT_INFO,
      bootstrap,
      client,
      endpointConfigStore,
      remoteDiscoveryService: makeUnavailableRemoteDiscoveryService(),
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('disconnected')
    expect(mgr.getLastErrorReason()).toBe('remoteDiscoveryUnavailable')
    expect(client.__urls).toEqual([])
  })

  it('remote mode fails fast and lands disconnected', async () => {
    // New behavior: single attempt then dormant. No automatic reconnect storm.
    const endpointConfigStore = new EndpointConfigStore()
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'nas',
      servers: [remoteServer('nas', 'NAS', 'wss://nas.local:9090')],
      cleanupTombstones: [],
    })

    const bootstrap = makeFakeBootstrap({
      error: new Error('NM should not be called in remote mode'),
    })
    const client = makeFakeClient({ conn: makeFakeConn() })
    const states: ConnectionState[] = []
    const mgr = new ConnectionManager({
      clientInfo: CLIENT_INFO,
      bootstrap,
      client,
      endpointConfigStore,
      remoteDiscoveryService: makeUnavailableRemoteDiscoveryService(),
    })
    mgr.onStateChange((s) => states.push(s))

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('disconnected')
    expect(states).not.toContain('reconnecting')
    expect(mgr.getLastErrorReason()).toBe('remoteDiscoveryUnavailable')
    expect(client.connect).not.toHaveBeenCalled()
  })
})

describe('ConnectionManager — local MBP1 async ownership', () => {
  const servers = [
    remoteServer('server-a', 'Server A', 'wss://a.example'),
    remoteServer('server-b', 'Server B', 'wss://b.example'),
  ]

  function initializeResult(name: string) {
    return {
      protocolVersion: '1.0',
      server: { name, version: '2.0', runtime: 'electron' as const },
      capabilities: {
        ffmpegAvailable: true,
        selectionKinds: ['direct'],
        progress: true,
        cancellation: true,
      },
      serverAdapters: [],
    }
  }

  function controllableConnection(
    result: Promise<ReturnType<typeof initializeResult>>
  ): {
    conn: MdxpConnection
    dispose: ReturnType<typeof vi.fn>
    sendNotification: ReturnType<typeof vi.fn>
    sendRequest: ReturnType<typeof vi.fn>
    fireRevoked: (reason: string) => void
  } {
    let revokedHandler: ((params: { reason: string }) => void) | null = null
    const dispose = vi.fn()
    const sendNotification = vi.fn()
    const sendRequest = vi.fn(async (method: string) => {
      if (method === Methods.MotrixInitialize) return await result
      return undefined
    })
    const conn = {
      listen: vi.fn(),
      sendRequest,
      sendNotification,
      onRequest: vi.fn(),
      onNotification: vi.fn((name: string, handler: unknown) => {
        if (name === '$/pair/revoked') {
          revokedHandler = handler as (params: { reason: string }) => void
        }
      }),
      dispose,
      raw: {} as never,
    } as unknown as MdxpConnection
    return {
      conn,
      dispose,
      sendNotification,
      sendRequest,
      fireRevoked: (reason: string) => {
        if (revokedHandler === null) {
          throw new Error('revoke handler not registered')
        }
        revokedHandler({ reason })
      },
    }
  }

  function switchableDependencies() {
    const get = vi.fn(async () => ({
      version: 3 as const,
      activeEndpointId: 'local',
      servers,
      cleanupTombstones: [],
    }))
    const endpointConfigStore = {
      get,
      getForLifecycleMutation: get,
      issueLifecycleWriter: () =>
        new EndpointConfigStore().issueLifecycleWriter(),
    } as unknown as EndpointConfigStore
    const revokeAll = vi.fn(async () => [])
    const credentialStore = makeCredentialStoreDouble({ revokeAll })
    return {
      endpointConfigStore,
      credentialStore,
      revokeAll,
      activateB: () => undefined,
    }
  }

  it('ignores late initialize, revoke, and close events from endpoint A after B connects', async () => {
    const initA = deferred<ReturnType<typeof initializeResult>>()
    const a = controllableConnection(initA.promise)
    const b = controllableConnection(
      Promise.resolve(initializeResult('server-b'))
    )
    const closeHandlers: Array<() => void> = []
    const sockets: FakeMbp1Socket[] = []
    let connectIndex = 0
    const client = {
      connect: vi.fn(async () => {
        const conn = connectIndex === 0 ? a.conn : b.conn
        connectIndex += 1
        return conn
      }),
      onClose: vi.fn((handler: () => void) => closeHandlers.push(handler)),
      close: vi.fn(),
      getConnection: vi.fn(),
    } as unknown as WebSocketClient
    const deps = switchableDependencies()
    const notify = vi.fn()
    const gate = new ConnectionGate()
    const mgr = new ConnectionManager({
      clientInfo: CLIENT_INFO,
      client,
      endpointConfigStore: deps.endpointConfigStore,
      credentialStore: deps.credentialStore,
      gate,
      notify,
      pairingCodeSource: 'test-code',
      discoveryService: {
        discoverForFirstPair: vi.fn(async () => [
          {
            transport: 'probe',
            wsPort: 16802,
            nonce: 'n',
            compatibility: 'compatible',
          },
        ]),
        preflightCompatibility: vi.fn(async (result) => result),
        ensureNonce: vi.fn(async (result) => result),
      } as unknown as DiscoveryService,
      createFrameChannel: () =>
        makeFakeMbp1Channel({ onRelease: (socket) => sockets.push(socket) }),
      createPairingFlow: () => ({
        run: async () => ({
          credentialId: 'fake-credential',
          envelope: {} as never,
          instanceId: 'fake-instance',
        }),
      }),
      createEnvelopeConnection: () => {
        const conn = connectIndex === 0 ? a.conn : b.conn
        connectIndex += 1
        return conn
      },
    })

    const connectA = mgr.connect({ allowLaunch: true, userInitiated: true })
    await vi.waitFor(() => {
      expect(mgr.getState()).toBe('handshaking')
      expect(a.sendRequest).toHaveBeenCalledWith(
        Methods.MotrixInitialize,
        expect.any(Object)
      )
    })

    mgr.stop()
    deps.activateB()
    await mgr.clearGateAndStart()
    expect(mgr.getServerIdentity()?.name).toBe('server-b')
    expect(sockets).toHaveLength(2)

    // These callbacks still exist in this deliberately hostile fake, just as
    // a queued browser close/revoke event can arrive after stop().
    a.fireRevoked('stale-a-revoke')
    sockets[0]?.fireClose()
    initA.resolve(initializeResult('server-a'))
    await connectA
    await flush()

    expect(mgr.getState()).toBe('connected')
    expect(mgr.getServerIdentity()).toEqual({
      name: 'server-b',
      version: '2.0',
      runtime: 'electron',
      instanceId: 'fake-instance',
    })
    expect(mgr.getLastError()).toBeNull()
    expect(deps.revokeAll).not.toHaveBeenCalled()
    expect((await gate.get()).reason).toBeNull()
    expect(notify).not.toHaveBeenCalled()
    expect(client.close).toHaveBeenCalledTimes(1)
    expect(a.sendNotification).not.toHaveBeenCalledWith(
      Notifications.MotrixInitialized,
      undefined
    )
  })

  it('closes a stale first-pair channel that resolves after a newer session', async () => {
    const staleFlow = deferred<{
      credentialId: string
      envelope: never
      instanceId: string
    }>()
    const channels = [makeFakeMbp1Channel(), makeFakeMbp1Channel()]
    const staleClose = vi.spyOn(channels[0] as { close: () => void }, 'close')
    let flowIndex = 0
    let channelIndex = 0
    const mgr = makeManager({
      createFrameChannel: () => channels[channelIndex++] ?? channels[1]!,
      createPairingFlow: () => ({
        run: async () => {
          const index = flowIndex++
          if (index === 0) return await staleFlow.promise
          return {
            credentialId: 'new-credential',
            envelope: {} as never,
            instanceId: 'new-instance',
          }
        },
      }),
    })

    const connectA = mgr.connect({ allowLaunch: true, userInitiated: true })
    await vi.waitFor(() => expect(flowIndex).toBe(1))
    mgr.stop()

    await mgr.connect({ allowLaunch: true, userInitiated: true })
    expect(mgr.getState()).toBe('connected')
    staleFlow.resolve({
      credentialId: 'stale-credential',
      envelope: {} as never,
      instanceId: 'stale-instance',
    })
    await connectA

    expect(staleClose).toHaveBeenCalled()
    expect(mgr.getState()).toBe('connected')
    expect(mgr.getServerIdentity()?.name).toBe('motrix')
  })
})

// ---------------------------------------------------------------------------
// Task-1 (Plan 3): $/task/* notification handlers + TaskEventStore
// ---------------------------------------------------------------------------

/**
 * A fake MdxpConnection that captures onNotification handlers and exposes
 * emitNotification() to simulate server-pushed notifications in tests.
 */
function makeFakeConnWithNotifications(): MdxpConnection & {
  emitNotification: (name: string, params: unknown) => void
} {
  const notificationHandlers = new Map<string, (params: unknown) => void>()

  const conn = {
    listen: vi.fn(),
    sendRequest: vi.fn(async (method: string) => {
      if (method === Methods.MotrixInitialize) {
        const result: Record<string, unknown> = {
          protocolVersion: '1.0',
          server: { name: 'motrix', version: '2.0', runtime: 'electron' },
          capabilities: {
            ffmpegAvailable: true,
            selectionKinds: ['direct'],
            progress: true,
            cancellation: true,
          },
          serverAdapters: [],
        }
        return result
      }
      return undefined
    }),
    sendNotification: vi.fn(),
    onRequest: vi.fn(),
    onNotification: vi.fn(
      (name: string, handler: (params: unknown) => void) => {
        notificationHandlers.set(name, handler)
      }
    ),
    dispose: vi.fn(),
    raw: {} as never,
    emitNotification: (name: string, params: unknown) => {
      const handler = notificationHandlers.get(name)
      if (!handler)
        throw new Error(`No handler registered for notification: ${name}`)
      handler(params)
    },
  }

  return conn as unknown as MdxpConnection & {
    emitNotification: (name: string, params: unknown) => void
  }
}

describe('ConnectionManager — $/task/* notification handlers', () => {
  it('binds retry progress to its source and includes the last observed progress in a failure', async () => {
    const taskProgress = vi.fn()
    const notify = Object.assign(vi.fn(), { taskProgress })
    const conn = makeFakeConnWithNotifications()
    const mgr = makeManager({ mbp1Conn: conn, notify })
    await mgr.connect({ allowLaunch: true, userInitiated: true })
    const progress = {
      taskId: 'retry-task',
      bytesDone: 40,
      bytesTotal: 100,
      speedBps: 10,
      etaSec: 6,
      phase: 'downloading',
    }
    conn.emitNotification('$/task/progress', progress)
    conn.emitNotification('$/task/error', {
      taskId: 'retry-task',
      code: 'NETWORK_ERROR',
      message: 'private details',
    })
    const failure = notify.mock.calls[0]![0]
    const observation = taskProgress.mock.calls[0]![0]
    expect(failure.failure).toEqual({
      taskId: 'retry-task',
      progress: { bytesDone: 40, phase: 'downloading' },
    })
    expect(observation.source).toEqual(failure.source)
    expect(observation.isCurrent()).toBe(true)
    mgr.stop()
    expect(observation.isCurrent()).toBe(false)
    conn.emitNotification('$/task/progress', { ...progress, bytesDone: 50 })
    expect(taskProgress).toHaveBeenCalledOnce()
  })

  it('keeps only a safe filename and invalidates delayed notifications after disconnect', async () => {
    const notify = vi.fn()
    const conn = makeFakeConnWithNotifications()
    const mgr = makeManager({ mbp1Conn: conn, notify })
    await mgr.connect({ allowLaunch: true, userInitiated: true })
    conn.emitNotification('$/task/completed', {
      taskId: 't-path',
      filePath: 'C:\\private\\folder\\report\u202e.txt',
      durationMs: 1000,
    })
    const input = notify.mock.calls[0]![0]
    expect(input.message).toBe('report .txt')
    expect(input.kind).toBe('task.completed')
    expect(input.source).toMatchObject({ endpointRevision: 0 })
    expect(input.isCurrent()).toBe(true)
    expect(mgr.isNotificationSourceCurrent(input.source)).toBe(true)
    for (const changed of [
      { endpointId: 'another-server' },
      { endpointRevision: 1 },
      { instanceId: 'another-instance' },
      { instanceId: null },
    ]) {
      expect(
        mgr.isNotificationSourceCurrent({ ...input.source, ...changed })
      ).toBe(false)
    }
    mgr.stop()
    expect(input.isCurrent()).toBe(false)
    expect(mgr.isNotificationSourceCurrent(input.source)).toBe(false)
  })

  it('fires a notification on $/task/completed and records progress', async () => {
    const notify = vi.fn()
    const taskEvents = new TaskEventStore()
    const conn = makeFakeConnWithNotifications()
    const mgr = makeManager({ mbp1Conn: conn, taskEvents, notify })

    await mgr.connect({ allowLaunch: true, userInitiated: true })
    expect(mgr.getState()).toBe('connected')

    // Simulate a progress push then a completed push
    conn.emitNotification('$/task/progress', {
      taskId: 't1',
      bytesDone: 50,
      bytesTotal: 100,
      speedBps: 10,
      etaSec: 5,
      phase: 'downloading',
    })
    conn.emitNotification('$/task/completed', {
      taskId: 't1',
      filePath: '/d/a.bin',
      durationMs: 1000,
    })

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('a.bin') })
    )
  })

  it('records progress into taskEvents on $/task/progress', async () => {
    const taskEvents = new TaskEventStore()
    const conn = makeFakeConnWithNotifications()
    const mgr = makeManager({ mbp1Conn: conn, taskEvents, notify: vi.fn() })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    conn.emitNotification('$/task/progress', {
      taskId: 't2',
      bytesDone: 30,
      bytesTotal: 100,
      speedBps: 5,
      etaSec: 10,
      phase: 'downloading',
    })

    // Progress is stored (not yet taken)
    expect(taskEvents.take('t2')?.bytesDone).toBe(30)
  })

  it('fires a notification with title "Download failed" on $/task/error', async () => {
    const notify = vi.fn()
    const conn = makeFakeConnWithNotifications()
    const mgr = makeManager({ mbp1Conn: conn, notify })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    conn.emitNotification('$/task/error', {
      taskId: 't3',
      code: 'NETWORK_ERROR',
      message: 'Request https://private.example/?token=secret timed out',
    })

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Download failed',
        message: 'Open the task list to view details.',
        kind: 'task.failed',
      })
    )
  })
})

// ---------------------------------------------------------------------------
// Task-2 (Plan 3): submitDownload + cancelDownload
// ---------------------------------------------------------------------------

describe('ConnectionManager — submitDownload + cancelDownload', () => {
  /** Fake conn that returns { taskId: 'task-9' } for 'download/submit' */
  function makeSubmitFakeConn(downloadDirectories = false): MdxpConnection & {
    sendRequest: ReturnType<typeof vi.fn>
  } {
    const conn = {
      listen: vi.fn(),
      sendRequest: vi.fn(async (method: string) => {
        if (method === Methods.MotrixInitialize) {
          return {
            protocolVersion: '1.0',
            server: { name: 'motrix', version: '2.0', runtime: 'electron' },
            capabilities: {
              ffmpegAvailable: true,
              downloadDirectories,
              selectionKinds: ['direct'],
              progress: true,
              cancellation: true,
            },
            serverAdapters: [],
          }
        }
        if (method === Methods.DownloadSubmit) return { taskId: 'task-9' }
        if (method === Methods.DownloadCancel) return { ok: true as const }
        return undefined
      }),
      sendNotification: vi.fn(),
      onRequest: vi.fn(),
      onNotification: vi.fn(),
      dispose: vi.fn(),
      raw: {} as never,
    }
    return conn as unknown as MdxpConnection & {
      sendRequest: ReturnType<typeof vi.fn>
    }
  }

  it('refuses explicit directories on older hosts before sending', async () => {
    const conn = makeSubmitFakeConn()
    const manager = makeManager({ mbp1Conn: conn })
    await manager.connect({ allowLaunch: true, userInitiated: true })
    await expect(
      manager.submitDownload(
        {
          source: {
            pageUrl: 'https://example.test',
            pageTitle: '',
            detectedAt: 0,
          },
          selection: {
            kind: 'magnet',
            uri: 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789',
          },
          meta: { suggestedFilename: '', qualityLabel: '' },
          saveDir: '/downloads',
        },
        { directoryInstanceId: 'instance' }
      )
    ).rejects.toThrow('download.directory-unavailable')
    expect(
      conn.sendRequest.mock.calls.some(
        ([method]) => method === Methods.DownloadSubmit
      )
    ).toBe(false)
    manager.stop()
  })

  it('refuses directory selections bound to a different paired instance', async () => {
    const conn = makeSubmitFakeConn(true)
    const manager = makeManager({ mbp1Conn: conn })
    await manager.connect({ allowLaunch: true, userInitiated: true })
    await expect(
      manager.submitDownload(
        {
          source: {
            pageUrl: 'https://example.test',
            pageTitle: '',
            detectedAt: 0,
          },
          selection: {
            kind: 'magnet',
            uri: 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789',
          },
          meta: { suggestedFilename: '', qualityLabel: '' },
          saveDir: '/downloads',
        },
        { directoryInstanceId: 'another-instance' }
      )
    ).rejects.toThrow('download.context-changed')
    expect(
      conn.sendRequest.mock.calls.some(
        ([method]) => method === Methods.DownloadSubmit
      )
    ).toBe(false)
    manager.stop()
  })

  it('reports a capability rejection as unsupported instead of an unknown download outcome', async () => {
    const conn = makeSubmitFakeConn()
    const manager = makeManager({ mbp1Conn: conn })
    await manager.connect({ allowLaunch: true, userInitiated: true })
    conn.sendRequest.mockRejectedValueOnce({
      code: ErrorCodes.CapabilityNotSupported,
      message: 'private native path',
    })
    await expect(
      manager.submitDownload({
        source: {
          pageUrl: 'https://example.com',
          pageTitle: 'Video',
          detectedAt: 1,
        },
        selection: {
          kind: 'direct',
          primary: {
            url: 'https://example.com/video.mp4',
            headers: {},
            cookies: [],
            refererPolicy: 'strict-origin-when-cross-origin',
          },
        },
        meta: { suggestedFilename: 'video.mp4', qualityLabel: '' },
      })
    ).rejects.toThrow('download.unsupported')
    expect(
      conn.sendRequest.mock.calls.filter(
        ([method]) => method === 'download/submit'
      )
    ).toHaveLength(1)
  })

  it('submitDownload forwards download/submit and returns the taskId', async () => {
    const fakeConn = makeSubmitFakeConn()
    const manager = makeManager({
      mbp1Conn: fakeConn as unknown as MdxpConnection,
    })

    await manager.connect({ allowLaunch: true, userInitiated: true })
    expect(manager.getState()).toBe('connected')

    const params = {
      source: { pageUrl: 'https://x.test/v', pageTitle: 'V', detectedAt: 0 },
      selection: {
        kind: 'direct' as const,
        primary: {
          url: 'https://x.test/a.mp4',
          headers: {},
          cookies: [],
          refererPolicy: 'strict-origin-when-cross-origin' as const,
        },
      },
      meta: { suggestedFilename: 'a.mp4', qualityLabel: '1080p' },
    }
    const res = await manager.submitDownload(params)
    // Every submit carries an idempotency key so Motrix can collapse
    // retransmits of the same logical submission.
    expect(fakeConn.sendRequest).toHaveBeenCalledWith('download/submit', {
      ...params,
      idempotencyKey: expect.stringMatching(/^.{8,128}$/),
    })
    expect(res).toEqual({ taskId: 'task-9' })
  })

  it('submitDownload mints a FRESH idempotency key per logical submit', async () => {
    const fakeConn = makeSubmitFakeConn()
    const manager = makeManager({
      mbp1Conn: fakeConn as unknown as MdxpConnection,
    })
    await manager.connect({ allowLaunch: true, userInitiated: true })

    const params = {
      source: { pageUrl: 'https://x.test/v', pageTitle: 'V', detectedAt: 0 },
      selection: {
        kind: 'direct' as const,
        primary: {
          url: 'https://x.test/a.mp4',
          headers: {},
          cookies: [],
          refererPolicy: 'strict-origin-when-cross-origin' as const,
        },
      },
      meta: { suggestedFilename: 'a.mp4', qualityLabel: '1080p' },
    }
    await manager.submitDownload(params)
    await manager.submitDownload(params)
    const keys = fakeConn.sendRequest.mock.calls
      .filter(([m]) => m === 'download/submit')
      .map(([, p]) => (p as { idempotencyKey?: string }).idempotencyKey)
    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toBe(keys[1])
  })

  it('submitDownload preserves a caller-provided idempotency key', async () => {
    const fakeConn = makeSubmitFakeConn()
    const manager = makeManager({
      mbp1Conn: fakeConn as unknown as MdxpConnection,
    })
    await manager.connect({ allowLaunch: true, userInitiated: true })

    const params = {
      source: { pageUrl: 'https://x.test/v', pageTitle: 'V', detectedAt: 0 },
      selection: {
        kind: 'direct' as const,
        primary: {
          url: 'https://x.test/a.mp4',
          headers: {},
          cookies: [],
          refererPolicy: 'strict-origin-when-cross-origin' as const,
        },
      },
      meta: { suggestedFilename: 'a.mp4', qualityLabel: '1080p' },
      idempotencyKey: 'caller-key-12345678',
    }
    await manager.submitDownload(params)
    expect(fakeConn.sendRequest).toHaveBeenCalledWith(
      'download/submit',
      expect.objectContaining({ idempotencyKey: 'caller-key-12345678' })
    )
  })

  it.each([null, {}, { taskId: 42 }])(
    'keeps a malformed submit receipt uncertain: %j',
    async (receipt) => {
      const fakeConn = makeSubmitFakeConn()
      const manager = makeManager({
        mbp1Conn: fakeConn as unknown as MdxpConnection,
      })
      await manager.connect({ allowLaunch: true, userInitiated: true })
      fakeConn.sendRequest.mockResolvedValueOnce(receipt)
      await expect(
        manager.submitDownload({
          source: {
            pageUrl: 'https://example.com/',
            pageTitle: 'File',
            detectedAt: 1,
          },
          selection: {
            kind: 'magnet',
            uri: 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789',
          },
          meta: { suggestedFilename: 'file', qualityLabel: 'source' },
        })
      ).rejects.toThrow('download.result-unknown')
      manager.stop()
    }
  )

  it('times out a submit whose response is permanently lost', async () => {
    const fakeConn = makeSubmitFakeConn()
    fakeConn.sendRequest.mockImplementation(async (method: string) => {
      if (method === Methods.MotrixInitialize) {
        return {
          protocolVersion: '1.0',
          server: { name: 'motrix', version: '2.0', runtime: 'electron' },
          capabilities: {
            ffmpegAvailable: true,
            selectionKinds: ['direct'],
            progress: true,
            cancellation: true,
          },
          serverAdapters: [],
        }
      }
      return await new Promise(() => {})
    })
    const manager = makeManager({
      mbp1Conn: fakeConn as unknown as MdxpConnection,
      requestTimeoutMs: 10,
    })
    await manager.connect({ allowLaunch: true, userInitiated: true })

    await expect(
      manager.submitDownload({
        source: {
          pageUrl: 'https://x.test/v',
          pageTitle: 'V',
          detectedAt: 0,
        },
        selection: {
          kind: 'direct',
          primary: {
            url: 'https://x.test/a.mp4',
            headers: {},
            cookies: [],
            refererPolicy: 'strict-origin-when-cross-origin',
          },
        },
        meta: { suggestedFilename: 'a.mp4', qualityLabel: '1080p' },
      })
    ).rejects.toThrow('download.result-unknown')
  })

  it('does not mark an unsent download unknown when health changes during journal persistence', async () => {
    const conn = makeSubmitFakeConn()
    const manager = makeManager({ mbp1Conn: conn, requestTimeoutMs: 10 })
    await manager.connect({ allowLaunch: true, userInitiated: true })
    const journal = deferred<void>()
    const started = deferred<void>()
    conn.sendRequest.mockImplementation(async () => new Promise(() => {}))
    const submitting = manager.submitDownload(
      {
        source: {
          pageUrl: 'https://example.test/',
          pageTitle: 'file',
          detectedAt: 0,
        },
        selection: {
          kind: 'magnet',
          uri: 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789',
        },
        meta: { suggestedFilename: 'file', qualityLabel: 'source' },
      },
      {
        onSubmitting: async () => {
          started.resolve()
          await journal.promise
        },
      }
    )
    const rejected = expect(submitting).rejects.toThrow(
      'download.connection-failed'
    )
    await started.promise
    const reading = manager.request(Methods.TaskList, {}).catch(() => {})
    await vi.waitFor(() =>
      expect(manager.getRpcStatus().health).toBe('checking')
    )
    journal.resolve()
    try {
      await rejected
      expect(
        conn.sendRequest.mock.calls.filter(
          ([method]) => method === Methods.DownloadSubmit
        )
      ).toHaveLength(0)
    } finally {
      manager.stop()
      await reading
    }
  })

  it('cancelDownload forwards download/cancel', async () => {
    const fakeConn = makeSubmitFakeConn()
    const manager = makeManager({
      mbp1Conn: fakeConn as unknown as MdxpConnection,
    })

    await manager.connect({ allowLaunch: true, userInitiated: true })
    expect(manager.getState()).toBe('connected')

    await manager.cancelDownload('task-9')
    expect(fakeConn.sendRequest).toHaveBeenCalledWith('download/cancel', {
      taskId: 'task-9',
    })
  })
})

// ---------------------------------------------------------------------------
// Task-4: task-activity observer (badge status signal)
// ---------------------------------------------------------------------------

describe('ConnectionManager activity delegation', () => {
  it('hasActiveTasks + onActivityChange delegate to the injected TaskEventStore', () => {
    const taskEvents = new TaskEventStore()
    const mgr = new ConnectionManager({ clientInfo: CLIENT_INFO, taskEvents })
    const cb = vi.fn()
    mgr.onActivityChange(cb)

    expect(mgr.hasActiveTasks()).toBe(false)
    taskEvents.recordProgress({ taskId: 't1' } as never)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(mgr.hasActiveTasks()).toBe(true)
    taskEvents.take('t1')
    expect(mgr.hasActiveTasks()).toBe(false)
  })

  it('clears stale task activity when the owned connection stops', () => {
    const taskEvents = new TaskEventStore()
    const mgr = new ConnectionManager({ clientInfo: CLIENT_INFO, taskEvents })
    taskEvents.recordProgress({ taskId: 't1' } as never)

    mgr.stop()

    expect(mgr.hasActiveTasks()).toBe(false)
  })
})
