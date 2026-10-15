/**
 * MBP1-specific `ConnectionManager` orchestration tests: everything that
 * `ConnectionManager.test.ts`'s generic (transport-agnostic) suite and the
 * dedicated `pairing-flow.test.ts`/`reconnect-flow.test.ts`/`discovery-
 * service.test.ts` crypto/protocol suites don't already cover — the wiring
 * that only exists at the orchestration layer: which branch `connectOnce`
 * takes, the recovery-order walk and its per-reason dispositions, the
 * pin-first-then-hint instanceId policy, and that the envelope handed to
 * `createEnvelopeConnection` is the one a flow actually produced.
 *
 * `PairingFlow`/`ReconnectFlow` themselves are always faked here via the
 * `createPairingFlow`/`createReconnectFlow` DI seams — the crypto is out of
 * scope for this file by design.
 */
import {
  type DownloadSubmitParams,
  type MdxpConnection,
  Methods,
} from '@motrix/mdxp'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BackendOperationCoordinator } from '@/background/BackendOperationCoordinator'
import { ConnectionGate } from '@/background/ConnectionGate'
import {
  ConnectionManager,
  type ConnectionManagerOptions,
  type ConnectionState,
  type Mbp1FrameChannel,
} from '@/background/ConnectionManager'
import { EndpointCatalogService } from '@/background/EndpointCatalogService'
import { EndpointConfigStore } from '@/background/EndpointConfigStore'
import {
  type BackendAuthority,
  createRemoteBackendAuthority,
  LOCAL_BACKEND_AUTHORITY,
} from '@/background/mbp1/backend-authority'
import { getClientInstallationId } from '@/background/mbp1/client-installation-id'
import {
  type CredentialLifecycleStore,
  type CredentialMutationBoundary,
  CredentialStore,
  type Principal,
  resolveCredentialLifecycleStore,
  type StoredCredential,
} from '@/background/mbp1/credential-store'
import type {
  DiscoveryResult,
  DiscoveryService,
} from '@/background/mbp1/discovery-service'
import type { EnvelopeCodec } from '@/background/mbp1/envelope'
import {
  PairingFlowError,
  type PairingFlowRunArgs,
} from '@/background/mbp1/pairing-flow'
import type { Pin, PinStore } from '@/background/mbp1/pin-store'
import {
  ReconnectFlowError,
  type ReconnectFlowRunArgs,
} from '@/background/mbp1/reconnect-flow'
import { computeVerifiedOrigin } from '@/background/mbp1/verified-origin'
import type {
  NativeBootstrap,
  NativeBootstrapResult,
} from '@/background/NativeBootstrap'
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

// ---------------------------------------------------------------------------
// Fakes. `CredentialStore`/`PinStore`/`DiscoveryService`/`NativeBootstrap`/
// `WebSocketClient` all have private fields, so a plain object literal can't
// structurally satisfy them — same constraint `ConnectionManager.test.ts`
// already works around with `as unknown as X`.
// ---------------------------------------------------------------------------

function makeFakeCredentialStore(order: StoredCredential[]): CredentialStore {
  const lifecycleRoot = new CredentialStore()
  const recoverOrder = vi.fn(async () => order)
  const ageOutUnacked = vi.fn(async () => {})
  const cleanupFirstPairOrphans = vi.fn(async () => {})
  return {
    // Preserve the old root spies for assertions while production code uses
    // only the authority-scoped view.
    recoverOrder,
    ageOutUnacked,
    cleanupFirstPairOrphans,
    forAttempt: vi.fn(
      (authority: BackendAuthority, boundary: CredentialMutationBoundary) =>
        Object.assign(lifecycleRoot.forAttempt(authority, boundary), {
          recoverOrder,
          // M5: connection attempts run housekeeping before recoverOrder.
          ageOutUnacked,
          cleanupFirstPairOrphans,
        })
    ),
  } as unknown as CredentialStore
}

function makeFakePinStore(pins: Record<string, Pin | null> = {}): PinStore {
  return {
    get: vi.fn(async (credentialId: string) => pins[credentialId] ?? null),
  } as unknown as PinStore
}

function makeFakeDiscoveryService(overrides: {
  wakeForReconnect?: (ids: string[]) => Promise<Map<string, DiscoveryResult>>
  discoverForReconnect?: (
    credentialId: string
  ) => Promise<DiscoveryResult | null>
  discoverForFirstPair?: (opts: {
    allowLaunch: boolean
    bindingPub?: Uint8Array
  }) => Promise<DiscoveryResult[]>
  preflightCompatibility?: (result: DiscoveryResult) => Promise<DiscoveryResult>
  ensureNonce?: (result: DiscoveryResult) => Promise<DiscoveryResult | null>
}): DiscoveryService {
  return {
    wakeForReconnect: vi.fn(
      overrides.wakeForReconnect ?? (async () => new Map())
    ),
    discoverForReconnect: vi.fn(
      overrides.discoverForReconnect ?? (async () => null)
    ),
    discoverForFirstPair: vi.fn(
      overrides.discoverForFirstPair ?? (async () => [])
    ),
    preflightCompatibility: vi.fn(
      overrides.preflightCompatibility ?? (async (r) => r)
    ),
    ensureNonce: vi.fn(overrides.ensureNonce ?? (async (r) => r)),
  } as unknown as DiscoveryService
}

function makeStoredCredential(id: string): StoredCredential {
  return {
    credentialId: id,
    mutualKey: 'aa'.repeat(32),
    principalKey: `principal-key-${id}`,
    state: 'committed',
    createdAt: Date.now(),
  }
}

function makeDiscoveryResult(
  overrides: Partial<DiscoveryResult> = {}
): DiscoveryResult {
  return {
    transport: 'probe',
    wsPort: 16802,
    compatibility: 'compatible',
    ...overrides,
  }
}

/** Distinct, opaque per-call sentinel — never actually sealed/opened here,
 *  only compared by reference (`toBe`) to prove wiring, not crypto. */
function fakeEnvelope(): EnvelopeCodec {
  return {} as unknown as EnvelopeCodec
}

function fakeSocket(): WebSocket {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket
}

function makeFakeChannel(): Mbp1FrameChannel {
  return {
    open: async () => {},
    sendText: async () => {},
    receiveText: async () => {
      throw new Error('makeFakeChannel: receiveText should not be called')
    },
    sendBinary: async () => {},
    receiveBinary: async () => {
      throw new Error('makeFakeChannel: receiveBinary should not be called')
    },
    close: () => {},
    release: () => ({ socket: fakeSocket(), queuedFrames: [] }),
  }
}

function makeFakeConn(): MdxpConnection {
  return {
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
    onNotification: vi.fn(),
    dispose: vi.fn(),
    raw: {} as never,
  } as unknown as MdxpConnection
}

function makeFakeServerConn(): MdxpConnection {
  const conn = makeFakeConn()
  vi.mocked(conn.sendRequest).mockImplementation(async (method: string) => {
    if (method === 'motrix/initialize') {
      return {
        protocolVersion: '1.0',
        server: { name: 'motrix', version: '2.0', runtime: 'server' },
        capabilities: {
          ffmpegAvailable: true,
          selectionKinds: ['direct'],
          progress: true,
          cancellation: true,
        },
        serverAdapters: [],
      } as never
    }
    if (method === 'download/submit') {
      return { taskId: 'remote-task' } as never
    }
    return undefined as never
  })
  return conn
}

function makeFakeBootstrap(): NativeBootstrap {
  return {
    discover: vi.fn(async (): Promise<NativeBootstrapResult> => {
      throw new Error(
        'NativeBootstrap.discover should not be called — every test here ' +
          'injects its own discoveryService'
      )
    }),
  } as unknown as NativeBootstrap
}

function makeFakeClient(): WebSocketClient {
  return {
    connect: vi.fn(async () => {
      throw new Error(
        'WebSocketClient.connect should not be called from the local (MBP1) path'
      )
    }),
    onClose: vi.fn(),
    close: vi.fn(),
    getConnection: vi.fn(),
  } as unknown as WebSocketClient
}

interface MakeManagerOptions extends Partial<ConnectionManagerOptions> {
  credentials?: StoredCredential[]
  pins?: Record<string, Pin | null>
  discovery?: Parameters<typeof makeFakeDiscoveryService>[0]
  /** Per-credentialId reconnect flow outcome: a `ReconnectFlowResult` to
   *  succeed with, or an `Error` (typically `ReconnectFlowError`) to throw. */
  reconnectOutcomes?: Record<string, { envelope: EnvelopeCodec } | Error>
  /** First-pair flow outcome. Defaults to an immediate success. */
  pairingOutcome?:
    | { credentialId: string; envelope: EnvelopeCodec; instanceId: string }
    | Error
  onReconnectRun?: (args: ReconnectFlowRunArgs) => void
  onPairingRun?: (args: PairingFlowRunArgs) => void
}

function makeManager(opts: MakeManagerOptions = {}): ConnectionManager {
  const {
    credentials,
    pins,
    discovery,
    reconnectOutcomes,
    pairingOutcome,
    onReconnectRun,
    onPairingRun,
    ...rest
  } = opts

  return new ConnectionManager({
    clientInfo: CLIENT_INFO,
    bootstrap: makeFakeBootstrap(),
    client: makeFakeClient(),
    pairingCodeSource: 'test-code',
    credentialStore: makeFakeCredentialStore(credentials ?? []),
    pinStore: makeFakePinStore(pins ?? {}),
    discoveryService: makeFakeDiscoveryService(discovery ?? {}),
    createFrameChannel: () => makeFakeChannel(),
    createReconnectFlow: () => ({
      run: async (args: ReconnectFlowRunArgs) => {
        onReconnectRun?.(args)
        const outcome = reconnectOutcomes?.[args.credential.credentialId]
        if (outcome === undefined) {
          throw new Error(
            `test bug: no reconnectOutcome configured for ${args.credential.credentialId}`
          )
        }
        if (outcome instanceof Error) throw outcome
        return outcome
      },
    }),
    createPairingFlow: () => ({
      run: async (args: PairingFlowRunArgs) => {
        onPairingRun?.(args)
        const outcome = pairingOutcome ?? {
          credentialId: 'fresh-credential',
          envelope: fakeEnvelope(),
          instanceId: 'fresh-instance',
        }
        if (outcome instanceof Error) throw outcome
        return outcome
      },
    }),
    createEnvelopeConnection: () => makeFakeConn(),
    closeReconnectDelayMs: 0,
    ...rest,
  })
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

describe('ConnectionManager MBP1 — local vs remote routing', () => {
  it('a local endpoint with no stored credential first-pairs via /pair?nonce=, never /v1?token=', async () => {
    const mgr = makeManager({
      discovery: {
        discoverForFirstPair: async () => [
          makeDiscoveryResult({ wsPort: 16803 }),
        ],
        ensureNonce: async (r) => ({ ...r, nonce: 'fresh-nonce' }),
      },
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('connected')
    expect(mgr.lastConnectUrl).toBe(
      'ws://127.0.0.1:16803/pair?nonce=fresh-nonce'
    )
    expect(mgr.lastConnectUrl).not.toContain('token=')
  })

  it('keeps websocket transport closed when remote discovery is unavailable', async () => {
    const endpointConfigStore = new EndpointConfigStore()
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'nas',
      servers: [
        {
          id: 'nas',
          name: 'NAS',
          url: 'wss://nas.local:9090',
          revision: 0,
          state: 'ready',
        },
      ],
      cleanupTombstones: [],
    })
    const client = makeFakeClient()
    vi.mocked(client.connect).mockImplementation(
      async () => makeFakeConn() as never
    )

    const mgr = new ConnectionManager({
      clientInfo: CLIENT_INFO,
      bootstrap: makeFakeBootstrap(),
      client,
      endpointConfigStore,
      remoteDiscoveryService: makeUnavailableRemoteDiscoveryService(),
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('disconnected')
    expect(mgr.getLastErrorReason()).toBe('remoteDiscoveryUnavailable')
    expect(mgr.lastConnectUrl).toBeNull()
    expect(client.connect).not.toHaveBeenCalled()
  })

  it('selects the remote authority gate instead of the injected local gate', async () => {
    const endpointConfigStore = new EndpointConfigStore()
    const authority = createRemoteBackendAuthority({
      endpointId: 'nas',
      wsBase: 'wss://nas.local:9090',
    })
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'nas',
      servers: [
        {
          id: 'nas',
          name: 'NAS',
          url: authority.canonicalWsBase,
          revision: 0,
          state: 'ready',
        },
      ],
      cleanupTombstones: [],
    })
    const localGate = new ConnectionGate()
    await localGate.pauseDenied('local-only denial')

    const mgr = new ConnectionManager({
      clientInfo: CLIENT_INFO,
      endpointConfigStore,
      gate: localGate,
      remoteDiscoveryService: makeUnavailableRemoteDiscoveryService(),
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getLastErrorReason()).toBe('remoteDiscoveryUnavailable')
    expect(mgr.getLastError()).not.toBe('local-only denial')
    expect((await localGate.get()).lastError).toBe('local-only denial')
  })

  it.each([
    [
      'WSS',
      'wss://motrix.example/bridge',
      'wss://motrix.example/bridge/pair?nonce=AQIDBAUGBwgJCgsMDQ4PEA',
    ],
    [
      'WS',
      'ws://nas.local:8888/bridge',
      'ws://nas.local:8888/bridge/pair?nonce=AQIDBAUGBwgJCgsMDQ4PEA',
    ],
  ])(
    'pairs a compatible remote Server on authority-derived %s routes',
    async (_transport, serverUrl, expectedPairUrl) => {
      const endpointConfigStore = new EndpointConfigStore()
      await endpointConfigStore.setForTest({
        version: 3,
        activeEndpointId: 'nas',
        servers: [
          {
            id: 'nas',
            name: 'NAS',
            url: serverUrl,
            revision: 0,
            state: 'ready',
          },
        ],
        cleanupTombstones: [],
      })
      const compatible = {
        status: 'compatible',
        untrustedDocument: {
          app: 'motrix-bridge',
          apiVersion: 1,
          instanceId: 'untrusted-route-hint',
          appVersion: '2.0',
          runtime: 'server',
          extensionPairing: { protocol: 'mbp1', versions: [1] },
          applicationProtocols: { mdxp: ['1.0'] },
        },
      }
      const remoteDiscoveryService = {
        discover: vi.fn(async () => compatible),
        requestNonce: vi.fn(async () => ({
          status: 'ready',
          nonce: 'AQIDBAUGBwgJCgsMDQ4PEA',
          ttlSeconds: 60,
        })),
      }
      let pairingArgs: PairingFlowRunArgs | null = null
      const mgr = makeManager({
        endpointConfigStore,
        remoteDiscoveryService: remoteDiscoveryService as never,
        onPairingRun: (args) => {
          pairingArgs = args
        },
        createEnvelopeConnection: () => makeFakeServerConn(),
      })

      await mgr.connect({ allowLaunch: false, userInitiated: true })

      expect(mgr.getState()).toBe('connected')
      expect(pairingArgs?.remotePairUrl).toBe(expectedPairUrl)
      expect(remoteDiscoveryService.requestNonce).toHaveBeenCalledWith(
        compatible
      )
      expect(mgr.getServerIdentity()?.runtime).toBe('server')
    }
  )

  it('maps a remote pairing WebSocket open failure to one non-specific transport reason', async () => {
    const endpointConfigStore = new EndpointConfigStore()
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'nas',
      servers: [
        {
          id: 'nas',
          name: 'NAS',
          url: 'wss://motrix.example/bridge',
          revision: 0,
          state: 'ready',
        },
      ],
      cleanupTombstones: [],
    })
    const mgr = makeManager({
      endpointConfigStore,
      remoteDiscoveryService: {
        discover: vi.fn(async () => ({
          status: 'compatible',
          untrustedDocument: {
            app: 'motrix-bridge',
            apiVersion: 1,
            instanceId: 'untrusted-route-hint',
            appVersion: '2.0',
            runtime: 'server',
            extensionPairing: { protocol: 'mbp1', versions: [1] },
            applicationProtocols: { mdxp: ['1.0'] },
          },
        })),
        requestNonce: vi.fn(async () => ({
          status: 'ready',
          nonce: 'AQIDBAUGBwgJCgsMDQ4PEA',
          ttlSeconds: 60,
        })),
      } as never,
      pairingOutcome: new PairingFlowError(
        'channelUnavailable',
        'browser hid whether DNS, TLS, proxy, or network failed'
      ),
    })

    await mgr.connect({ allowLaunch: false, userInitiated: true })

    expect(mgr.getState()).toBe('disconnected')
    expect(mgr.getLastErrorReason()).toBe('remoteTransportUnavailable')
    expect(mgr.getLastError()).toBe(
      'the remote Motrix pairing WebSocket could not be opened'
    )
  })

  it('maps a remote reconnect WebSocket open failure to the same transport reason', async () => {
    const endpointConfigStore = new EndpointConfigStore()
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'nas',
      servers: [
        {
          id: 'nas',
          name: 'NAS',
          url: 'wss://motrix.example/bridge',
          revision: 0,
          state: 'ready',
        },
      ],
      cleanupTombstones: [],
    })
    const credential = {
      ...makeStoredCredential('remote-credential'),
      authenticatedInstanceId: 'authenticated-server-instance',
    }
    const mgr = makeManager({
      endpointConfigStore,
      credentials: [credential],
      reconnectOutcomes: {
        'remote-credential': new ReconnectFlowError(
          'channelUnavailable',
          'browser hid whether DNS, TLS, proxy, or network failed'
        ),
      },
      remoteDiscoveryService: {
        discover: vi.fn(async () => ({
          status: 'compatible',
          untrustedDocument: {
            app: 'motrix-bridge',
            apiVersion: 1,
            instanceId: 'untrusted-route-hint',
            appVersion: '2.0',
            runtime: 'server',
            extensionPairing: { protocol: 'mbp1', versions: [1] },
            applicationProtocols: { mdxp: ['1.0'] },
          },
        })),
      } as never,
    })

    await mgr.connect({ allowLaunch: false, userInitiated: false })

    expect(mgr.getState()).toBe('disconnected')
    expect(mgr.getLastErrorReason()).toBe('remoteTransportUnavailable')
    expect(mgr.getLastError()).toBe(
      'the remote Motrix WebSocket could not be opened'
    )
  })

  it('blocks remote submits until scoped consent and strips sensitive data by default', async () => {
    const endpointConfigStore = new EndpointConfigStore()
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'nas',
      servers: [
        {
          id: 'nas',
          name: 'NAS',
          url: 'wss://motrix.example/bridge',
          revision: 0,
          state: 'ready',
        },
      ],
      cleanupTombstones: [],
    })
    const discovery = {
      status: 'compatible',
      untrustedDocument: {
        app: 'motrix-bridge',
        apiVersion: 1,
        instanceId: 'route-hint',
        appVersion: '2.0',
        runtime: 'server',
        extensionPairing: { protocol: 'mbp1', versions: [1] },
        applicationProtocols: { mdxp: ['1.0'] },
      },
    }
    const remoteDiscoveryService = {
      discover: vi.fn(async () => discovery),
      requestNonce: vi.fn(async () => ({
        status: 'ready',
        nonce: 'AQIDBAUGBwgJCgsMDQ4PEA',
        ttlSeconds: 60,
      })),
    }
    const connections: MdxpConnection[] = []
    const mgr = makeManager({
      endpointConfigStore,
      credentials: [
        {
          ...makeStoredCredential('remote-credential'),
          authenticatedInstanceId: 'fresh-instance',
        },
      ],
      reconnectOutcomes: { 'remote-credential': { envelope: fakeEnvelope() } },
      remoteDiscoveryService: remoteDiscoveryService as never,
      createEnvelopeConnection: () => {
        const conn = makeFakeServerConn()
        connections.push(conn)
        return conn
      },
    })
    const submission: DownloadSubmitParams = {
      source: {
        pageUrl: 'https://example.com/watch',
        pageTitle: 'Page',
        detectedAt: 1,
      },
      selection: {
        kind: 'direct',
        primary: {
          url: 'https://cdn.example.com/video.mp4',
          headers: {
            Authorization: 'Bearer secret',
            Referer: 'https://example.com',
          },
          cookies: [
            { name: 'session', value: 'secret', domain: 'example.com' },
          ],
          refererPolicy: 'strict-origin-when-cross-origin',
        },
      },
      meta: { suggestedFilename: 'video.mp4', qualityLabel: 'source' },
    }

    await mgr.connect({ allowLaunch: false, userInitiated: true })
    await expect(mgr.submitDownload(submission)).rejects.toMatchObject({
      reason: 'permissionRequired',
    })

    await mgr.replaceRemoteBackendPolicy({
      remoteDataBoundaryAcceptedAt: 1,
      allowRequestCredentials: false,
      allowCustomHeaders: false,
      allowPageContent: false,
      allowServerUrlProbe: false,
      allowServerUrlResolve: false,
      allowAutomaticTakeover: false,
    })
    // The policy mutation response is also the completion acknowledgement for
    // its mandatory capability renegotiation; callers must never observe an
    // in-flight `bootstrapping` state after the promise resolves.
    expect(mgr.getState()).toBe('connected')
    await expect(
      mgr.submitDownload(submission, { automaticTakeover: true })
    ).rejects.toMatchObject({ reason: 'permissionRequired' })
    await expect(mgr.submitDownload(submission)).resolves.toEqual({
      taskId: 'remote-task',
    })
    await expect(
      mgr.submitDownload(submission, { automaticTakeover: false })
    ).resolves.toEqual({
      taskId: 'remote-task',
    })
    const beforeGuardedSubmit = vi.mocked(connections.at(-1)!.sendRequest).mock
      .calls.length
    let checks = 0
    await expect(
      mgr.submitDownload(submission, {
        automaticTakeover: false,
        assertCurrent: () => {
          checks += 1
          if (checks === 2)
            throw new Error('endpoint changed while reading policy')
        },
      })
    ).rejects.toThrow('endpoint changed while reading policy')
    expect(checks).toBe(2)
    expect(vi.mocked(connections.at(-1)!.sendRequest).mock.calls).toHaveLength(
      beforeGuardedSubmit
    )
    const lastConnection = connections.at(-1)
    expect(lastConnection?.sendRequest).toHaveBeenCalledWith(
      'download/submit',
      expect.objectContaining({
        selection: expect.objectContaining({
          primary: expect.objectContaining({ headers: {}, cookies: [] }),
        }),
      })
    )
  })

  it('reconnects remote credentials with the authenticated instance id, not discovery hint', async () => {
    const endpointConfigStore = new EndpointConfigStore()
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'nas',
      servers: [
        {
          id: 'nas',
          name: 'NAS',
          url: 'wss://motrix.example/bridge',
          revision: 0,
          state: 'ready',
        },
      ],
      cleanupTombstones: [],
    })
    const credential = {
      ...makeStoredCredential('remote-credential'),
      authenticatedInstanceId: 'authenticated-server-instance',
    }
    let reconnectArgs: ReconnectFlowRunArgs | null = null
    const mgr = makeManager({
      endpointConfigStore,
      credentials: [credential],
      reconnectOutcomes: {
        'remote-credential': { envelope: fakeEnvelope() },
      },
      remoteDiscoveryService: {
        discover: vi.fn(async () => ({
          status: 'compatible',
          untrustedDocument: {
            app: 'motrix-bridge',
            apiVersion: 1,
            instanceId: 'attacker-controlled-hint',
            appVersion: '2.0',
            runtime: 'server',
            extensionPairing: { protocol: 'mbp1', versions: [1] },
            applicationProtocols: { mdxp: ['1.0'] },
          },
        })),
      } as never,
      onReconnectRun: (args) => {
        reconnectArgs = args
      },
      createEnvelopeConnection: () => makeFakeServerConn(),
    })

    await mgr.connect({ allowLaunch: false, userInitiated: false })

    expect(mgr.getState()).toBe('connected')
    expect(reconnectArgs?.instanceId).toBe('authenticated-server-instance')
    expect(reconnectArgs?.remoteV1Url).toBe('wss://motrix.example/bridge/v1')
  })

  it('honors a denial only from the selected remote authority gate', async () => {
    const endpointConfigStore = new EndpointConfigStore()
    const authority = createRemoteBackendAuthority({
      endpointId: 'nas',
      wsBase: 'wss://nas.local:9090',
    })
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'nas',
      servers: [
        {
          id: 'nas',
          name: 'NAS',
          url: authority.canonicalWsBase,
          revision: 0,
          state: 'ready',
        },
      ],
      cleanupTombstones: [],
    })
    const remoteGate = ConnectionGate.forAuthority(authority)
    await remoteGate.pauseDenied('remote-only denial')

    const mgr = new ConnectionManager({
      clientInfo: CLIENT_INFO,
      endpointConfigStore,
      gate: new ConnectionGate(),
    })

    await mgr.connect({ allowLaunch: false, userInitiated: false })

    expect(mgr.getState()).toBe('denied')
    expect(mgr.getLastError()).toBe('remote-only denial')
    expect(mgr.getLastErrorReason()).toBeNull()
  })

  it('retires Server A live verdict before Server B becomes selected', async () => {
    const endpointConfigStore = new EndpointConfigStore()
    const serverA = {
      id: 'server-a',
      name: 'Server A',
      url: 'wss://a.example/bridge',
      revision: 0,
      state: 'ready' as const,
    }
    const serverB = {
      id: 'server-b',
      name: 'Server B',
      url: 'wss://b.example/bridge',
      revision: 0,
      state: 'ready' as const,
    }
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: serverA.id,
      servers: [serverA, serverB],
      cleanupTombstones: [],
    })
    const authorityA = createRemoteBackendAuthority({
      endpointId: serverA.id,
      wsBase: serverA.url,
    })
    await ConnectionGate.forAuthority(authorityA).pauseDenied(
      'Server A denied this browser'
    )
    const mgr = new ConnectionManager({
      clientInfo: CLIENT_INFO,
      endpointConfigStore,
      remoteDiscoveryService: makeUnavailableRemoteDiscoveryService(),
    })

    await mgr.connect({ allowLaunch: false, userInitiated: false })
    expect(mgr.getState()).toBe('denied')
    expect(mgr.getLastError()).toBe('Server A denied this browser')

    // Production calls this before changing EndpointConfigStore. Every
    // synchronous listener observing the disconnected transition must see a
    // blank process-local verdict, never A's error under B's selector row.
    mgr.stopForEndpointChange()
    expect(mgr.getState()).toBe('disconnected')
    expect(mgr.getLastError()).toBeNull()
    expect(mgr.getLastErrorReason()).toBeNull()
    expect(mgr.getLastErrorRetryAtMs()).toBeNull()
    expect(mgr.getPendingPairingCode()).toBeNull()

    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: serverB.id,
      servers: [serverA, serverB],
      cleanupTombstones: [],
    })
    await mgr.connect({ allowLaunch: false, userInitiated: true })

    expect(mgr.getState()).toBe('disconnected')
    expect(mgr.getLastErrorReason()).toBe('remoteDiscoveryUnavailable')
    expect(mgr.getLastError()).not.toContain('Server A')
    expect(
      (await ConnectionGate.forAuthority(authorityA).get()).lastError
    ).toBe('Server A denied this browser')
  })

  it('does not reinterpret an active cleanup-pending remote profile as local', async () => {
    const endpointConfigStore = new EndpointConfigStore()
    const authority = createRemoteBackendAuthority({
      endpointId: 'nas',
      wsBase: 'wss://nas.local:9090',
    })
    const replacementAuthority = createRemoteBackendAuthority({
      endpointId: 'nas',
      wsBase: 'wss://nas-new.local:9090',
    })
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'nas',
      servers: [
        {
          id: 'nas',
          name: 'NAS',
          url: replacementAuthority.canonicalWsBase,
          revision: 1,
          state: 'cleanup-pending',
        },
      ],
      cleanupTombstones: [
        {
          endpointId: 'nas',
          canonicalWsBase: authority.canonicalWsBase,
          invalidatedRevision: 0,
        },
      ],
    })
    const localGate = new ConnectionGate()
    const shouldAutoConnect = vi.spyOn(localGate, 'shouldAutoConnect')
    const credentialStore = makeFakeCredentialStore([])
    const mgr = new ConnectionManager({
      clientInfo: CLIENT_INFO,
      endpointConfigStore,
      gate: localGate,
      credentialStore,
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('disconnected')
    expect(shouldAutoConnect).not.toHaveBeenCalled()
    expect(credentialStore.forAttempt).not.toHaveBeenCalled()
    expect(mgr.lastConnectUrl).toBeNull()
  })
})

describe('ConnectionManager MBP1 — explicit operator denial', () => {
  const discovery = {
    discoverForFirstPair: async () => [makeDiscoveryResult()],
    ensureNonce: async (result: DiscoveryResult) => ({
      ...result,
      nonce: 'fresh-nonce',
    }),
  }

  it('persists wire denied as a terminal gate verdict', async () => {
    const gate = new ConnectionGate()
    const mgr = makeManager({
      gate,
      discovery,
      pairingOutcome: new PairingFlowError(
        'peerRejected',
        'the operator denied pairing',
        { pairErrorCode: 'denied' }
      ),
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('denied')
    expect((await gate.get()).reason).toBe('denied')
  })

  it('keeps wire aborted as a non-terminal session teardown', async () => {
    const gate = new ConnectionGate()
    const mgr = makeManager({
      gate,
      discovery,
      pairingOutcome: new PairingFlowError(
        'peerRejected',
        'the pairing session was aborted',
        { pairErrorCode: 'aborted' }
      ),
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('disconnected')
    expect((await gate.get()).reason).toBeNull()
  })
})

describe('ConnectionManager MBP1 — remote incarnation edit/delete readiness', () => {
  it.each(['edit', 'delete'] as const)(
    '%s stops the captured attempt without waiting for its network phase and rejects its late credential write',
    async (operation) => {
      const endpointConfigStore = new EndpointConfigStore()
      const oldAuthority = createRemoteBackendAuthority({
        endpointId: 'server-a',
        wsBase: 'wss://a.example/bridge',
      })
      const server = {
        id: 'server-a',
        name: 'Server A',
        url: oldAuthority.canonicalWsBase,
        revision: 0,
        state: 'ready' as const,
      }
      await endpointConfigStore.setForTest({
        version: 3,
        activeEndpointId: server.id,
        servers: [server],
        cleanupTombstones: [],
      })
      const coordinator = new BackendOperationCoordinator()
      const credentialStore = new CredentialStore()
      const localGate = new ConnectionGate()
      const manager = new ConnectionManager({
        clientInfo: CLIENT_INFO,
        endpointConfigStore,
        backendOperationCoordinator: coordinator,
        credentialStore,
        gate: localGate,
      })
      const catalog = new EndpointCatalogService(
        endpointConfigStore,
        {
          retire: async (authority) => {
            await credentialStore.revokeAuthority(authority)
            await ConnectionGate.forAuthority(authority).clear()
          },
        },
        {
          coordinator,
          beforeConnectionChange: () => manager.stop(),
          afterConnectionChange: () => undefined,
        }
      )
      const scope = await (
        manager as unknown as {
          captureEndpointAttempt(
            generation: number
          ): Promise<{ lifecycleCredentials: CredentialLifecycleStore }>
        }
      ).captureEndpointAttempt(0)
      const principal: Principal = {
        browser: CLIENT_INFO.browser,
        verifiedOrigin: computeVerifiedOrigin(),
        clientInstallationId: await getClientInstallationId(),
      }

      let releaseNetworkPhase!: () => void
      const networkPhase = new Promise<void>((resolve) => {
        releaseNetworkPhase = resolve
      })
      const lateWrite = (async () => {
        await networkPhase
        await scope.lifecycleCredentials.writeProvisionalUnacked(
          principal,
          { credentialId: 'late-remote', mutualKey: 'late-key' },
          'remote-instance'
        )
      })()

      if (operation === 'edit') {
        await catalog.updateServer(
          server.id,
          {
            name: server.name,
            url: server.url,
            revision: server.revision,
          },
          { name: server.name, url: 'wss://a-new.example/bridge' }
        )
      } else {
        await catalog.removeServer(server.id, {
          name: server.name,
          url: server.url,
          revision: server.revision,
        })
      }

      // The catalogue operation completed while the simulated network phase
      // was still pending. A hostile continuation receives no durable power.
      releaseNetworkPhase()
      await expect(lateWrite).rejects.toBeInstanceOf(Error)

      const config = await endpointConfigStore.getForLifecycleMutation()
      expect(config.cleanupTombstones).toEqual([])
      if (operation === 'edit') {
        expect(config.servers).toEqual([
          expect.objectContaining({
            id: server.id,
            revision: 1,
            state: 'ready',
            url: 'wss://a-new.example/bridge',
          }),
        ])
      } else {
        expect(config.activeEndpointId).toBe('local')
        expect(config.servers).toEqual([])
      }
      expect(
        await credentialStore
          .forAuthorityForTest(oldAuthority)
          .recoverOrder(principal)
      ).toEqual([])
      expect((await localGate.get()).reason).toBeNull()
    }
  )

  it('rejects an old remote lifecycle facade after an active switch that does not retire its authority', async () => {
    const endpointConfigStore = new EndpointConfigStore()
    const authorityA = createRemoteBackendAuthority({
      endpointId: 'server-a',
      wsBase: 'wss://a.example/bridge',
    })
    const authorityB = createRemoteBackendAuthority({
      endpointId: 'server-b',
      wsBase: 'wss://b.example/bridge',
    })
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'server-a',
      servers: [
        {
          id: 'server-a',
          name: 'Server A',
          url: authorityA.canonicalWsBase,
          revision: 0,
          state: 'ready',
        },
        {
          id: 'server-b',
          name: 'Server B',
          url: authorityB.canonicalWsBase,
          revision: 0,
          state: 'ready',
        },
      ],
      cleanupTombstones: [],
    })
    const coordinator = new BackendOperationCoordinator()
    let durableWrites = 0
    let boundary: CredentialMutationBoundary | null = null
    const lifecycleStore = {
      writeProvisionalUnacked: async () => {
        if (boundary === null) throw new Error('test boundary was not issued')
        await boundary.run(async () => {
          durableWrites += 1
        })
      },
    } as unknown as CredentialLifecycleStore
    const credentialStore = {
      forAttempt: vi.fn(
        (
          _authority: BackendAuthority,
          issuedBoundary: CredentialMutationBoundary
        ) => {
          boundary = issuedBoundary
          return lifecycleStore
        }
      ),
    } as unknown as CredentialStore
    const manager = new ConnectionManager({
      clientInfo: CLIENT_INFO,
      endpointConfigStore,
      backendOperationCoordinator: coordinator,
      credentialStore,
    })
    const catalog = new EndpointCatalogService(
      endpointConfigStore,
      { retire: async () => undefined },
      {
        coordinator,
        beforeConnectionChange: () => manager.stop(),
        afterConnectionChange: () => undefined,
      }
    )
    const scope = await (
      manager as unknown as {
        captureEndpointAttempt(
          generation: number
        ): Promise<{ credentials: CredentialLifecycleStore }>
      }
    ).captureEndpointAttempt(0)

    await catalog.activate('server-b')

    await expect(
      scope.credentials.writeProvisionalUnacked(
        {
          browser: CLIENT_INFO.browser,
          verifiedOrigin: computeVerifiedOrigin(),
          clientInstallationId: await getClientInstallationId(),
        },
        { credentialId: 'stale-a', mutualKey: 'stale-key' },
        'instance-a'
      )
    ).rejects.toBeInstanceOf(Error)
    expect(durableWrites).toBe(0)
    expect(await endpointConfigStore.getForLifecycleMutation()).toMatchObject({
      activeEndpointId: 'server-b',
    })
  })
})

describe('ConnectionManager MBP1 — candidate choice ownership', () => {
  const candidates = [
    makeDiscoveryResult({ wsPort: 16802 }),
    makeDiscoveryResult({ wsPort: 16803 }),
  ]

  it('uses an explicit candidate exactly for the lifecycle intent that claims it', async () => {
    let selectedPort: number | null = null
    const mgr = makeManager({
      discovery: {
        discoverForFirstPair: async () => candidates,
        ensureNonce: async (result) => ({ ...result, nonce: 'fresh-nonce' }),
      },
      onPairingRun: (args) => {
        selectedPort = args.discovery.wsPort
      },
    })

    mgr.choosePairCandidate(16803)
    await mgr.clearGateAndStart()

    expect(selectedPort).toBe(16803)
  })

  it('drops an unclaimed candidate choice when stop invalidates the lifecycle', async () => {
    let selectedPort: number | null = null
    const mgr = makeManager({
      discovery: {
        discoverForFirstPair: async () => candidates,
        ensureNonce: async (result) => ({ ...result, nonce: 'fresh-nonce' }),
      },
      onPairingRun: (args) => {
        selectedPort = args.discovery.wsPort
      },
    })

    mgr.choosePairCandidate(16803)
    mgr.stop()
    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(selectedPort).toBe(16802)
  })

  it('does not leak a choice from a superseded discovery into its replacement', async () => {
    let discoveryCalls = 0
    let firstDiscoveryEntered!: () => void
    let releaseFirstDiscovery!: () => void
    const firstEntered = new Promise<void>((resolve) => {
      firstDiscoveryEntered = resolve
    })
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirstDiscovery = resolve
    })
    const selectedPorts: number[] = []
    const mgr = makeManager({
      discovery: {
        discoverForFirstPair: async () => {
          discoveryCalls += 1
          if (discoveryCalls === 1) {
            firstDiscoveryEntered()
            await firstBlocked
          }
          return candidates
        },
        ensureNonce: async (result) => ({ ...result, nonce: 'fresh-nonce' }),
      },
      onPairingRun: (args) => {
        selectedPorts.push(args.discovery.wsPort)
      },
    })

    mgr.choosePairCandidate(16803)
    const first = mgr.connect({ allowLaunch: true, userInitiated: true })
    await firstEntered

    mgr.stop()
    const replacement = mgr.connect({
      allowLaunch: true,
      userInitiated: true,
    })
    await replacement
    releaseFirstDiscovery()
    await first

    expect(selectedPorts).toEqual([16802])
  })
})

describe('ConnectionManager MBP1 — verifiedOrigin / Principal wiring', () => {
  it('passes verifiedOrigin, browser, and clientInstallationId through to CredentialStore.recoverOrder', async () => {
    let capturedPrincipal: Principal | undefined
    const credentialStore = makeFakeCredentialStore([])
    vi.mocked(credentialStore.recoverOrder).mockImplementation(
      async (p: Principal) => {
        capturedPrincipal = p
        return []
      }
    )

    const mgr = makeManager({
      credentialStore,
      discovery: {
        discoverForFirstPair: async () => [makeDiscoveryResult()],
        ensureNonce: async (r) => ({ ...r, nonce: 'n' }),
      },
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(capturedPrincipal).toBeDefined()
    expect(capturedPrincipal?.browser).toBe('chromium')
    // The exact string is pinned in verified-origin.test.ts; here we only
    // confirm it's the same non-empty value ConnectionManager actually
    // wires through, not a placeholder or something computed inline.
    expect(capturedPrincipal?.verifiedOrigin).toBeTruthy()
    expect(capturedPrincipal?.clientInstallationId).toBeTruthy()
  })
})

describe('ConnectionManager MBP1 — instanceId: pin-first-then-hint', () => {
  it('prefers the pin instanceId over the untrusted discovery hint when both exist', async () => {
    const credential = makeStoredCredential('cred-1')
    let seenInstanceId: string | undefined
    const mgr = makeManager({
      credentials: [credential],
      pins: { 'cred-1': { port: 16802, instanceId: 'pinned-instance' } },
      discovery: {
        discoverForReconnect: async () =>
          makeDiscoveryResult({ instanceId: 'untrusted-hint-instance' }),
      },
      reconnectOutcomes: { 'cred-1': { envelope: fakeEnvelope() } },
      onReconnectRun: (args) => {
        seenInstanceId = args.instanceId
      },
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('connected')
    expect(seenInstanceId).toBe('pinned-instance')
    expect(mgr.getServerIdentity()?.instanceId).toBe('pinned-instance')
    expect(
      mgr.isNotificationSourceCurrent({
        endpointId: 'local',
        endpointRevision: 0,
        instanceId: 'pinned-instance',
      })
    ).toBe(true)
    expect(
      mgr.isNotificationSourceCurrent({
        endpointId: 'local',
        endpointRevision: 0,
        instanceId: 'untrusted-hint-instance',
      })
    ).toBe(false)
  })

  it('falls back to the discovery hint when no pin exists for the credential', async () => {
    const credential = makeStoredCredential('cred-1')
    let seenInstanceId: string | undefined
    const mgr = makeManager({
      credentials: [credential],
      pins: {},
      discovery: {
        discoverForReconnect: async () =>
          makeDiscoveryResult({ instanceId: 'untrusted-hint-instance' }),
      },
      reconnectOutcomes: { 'cred-1': { envelope: fakeEnvelope() } },
      onReconnectRun: (args) => {
        seenInstanceId = args.instanceId
      },
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('connected')
    expect(seenInstanceId).toBe('untrusted-hint-instance')
  })

  it('skips a candidate with neither a pin nor a discovery hint instanceId', async () => {
    const credA = makeStoredCredential('cred-a')
    const credB = makeStoredCredential('cred-b')
    const attempted: string[] = []
    const mgr = makeManager({
      credentials: [credA, credB],
      pins: {},
      discovery: {
        discoverForReconnect: async (credentialId) => {
          attempted.push(credentialId)
          if (credentialId === 'cred-a') {
            // Live, but the responder didn't include an instanceId hint —
            // structurally impossible via the real `DiscoveryResult` type,
            // but this orchestration guard exists precisely so a
            // discovery-layer bug here fails closed instead of crashing.
            return { transport: 'probe', wsPort: 16802 } as DiscoveryResult
          }
          return makeDiscoveryResult({ instanceId: 'b-instance' })
        },
      },
      reconnectOutcomes: { 'cred-b': { envelope: fakeEnvelope() } },
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('connected')
    expect(attempted).toEqual(['cred-a', 'cred-b'])
  })
})

describe('ConnectionManager MBP1 — recovery-order walk', () => {
  it('walks past a credential discovery finds no live endpoint for', async () => {
    const credA = makeStoredCredential('cred-a')
    const credB = makeStoredCredential('cred-b')
    const attempted: string[] = []
    const mgr = makeManager({
      credentials: [credA, credB],
      discovery: {
        discoverForReconnect: async (credentialId) => {
          attempted.push(credentialId)
          if (credentialId === 'cred-a') return null
          return makeDiscoveryResult({ instanceId: 'b-instance' })
        },
      },
      reconnectOutcomes: { 'cred-b': { envelope: fakeEnvelope() } },
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('connected')
    expect(attempted).toEqual(['cred-a', 'cred-b'])
  })

  it('authFailed advances the walk to the next stored credential', async () => {
    const credA = makeStoredCredential('cred-a')
    const credB = makeStoredCredential('cred-b')
    const attempted: string[] = []
    const mgr = makeManager({
      credentials: [credA, credB],
      discovery: {
        discoverForReconnect: async (credentialId) => {
          attempted.push(credentialId)
          return makeDiscoveryResult({ instanceId: `${credentialId}-instance` })
        },
      },
      reconnectOutcomes: {
        'cred-a': new ReconnectFlowError('authFailed', 'bad mac'),
        'cred-b': { envelope: fakeEnvelope() },
      },
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('connected')
    expect(attempted).toEqual(['cred-a', 'cred-b'])
  })

  it('channelUnavailable does NOT advance the walk — the whole attempt fails instead', async () => {
    const credA = makeStoredCredential('cred-a')
    const credB = makeStoredCredential('cred-b')
    const attempted: string[] = []
    const states: ConnectionState[] = []
    const mgr = makeManager({
      credentials: [credA, credB],
      discovery: {
        discoverForReconnect: async (credentialId) => {
          attempted.push(credentialId)
          return makeDiscoveryResult({ instanceId: `${credentialId}-instance` })
        },
      },
      reconnectOutcomes: {
        'cred-a': new ReconnectFlowError(
          'channelUnavailable',
          'no frame arrived'
        ),
        // cred-b would succeed if the walk (wrongly) reached it.
        'cred-b': { envelope: fakeEnvelope() },
      },
    })
    mgr.onStateChange((s) => states.push(s))

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(attempted).toEqual(['cred-a'])
    expect(mgr.getState()).toBe('disconnected')
    expect(states).not.toContain('reconnecting')
  })

  it('internalError does NOT advance the walk — the whole attempt fails instead', async () => {
    const credA = makeStoredCredential('cred-a')
    const credB = makeStoredCredential('cred-b')
    const attempted: string[] = []
    const mgr = makeManager({
      credentials: [credA, credB],
      discovery: {
        discoverForReconnect: async (credentialId) => {
          attempted.push(credentialId)
          return makeDiscoveryResult({ instanceId: `${credentialId}-instance` })
        },
      },
      reconnectOutcomes: {
        'cred-a': new ReconnectFlowError('internalError', 'storage rejected'),
        'cred-b': { envelope: fakeEnvelope() },
      },
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(attempted).toEqual(['cred-a'])
    expect(mgr.getState()).toBe('disconnected')
  })

  it('retains pairing after explicit reconnect authentication fails', async () => {
    const credA = makeStoredCredential('cred-a')
    let firstPairAttempted = false
    const mgr = makeManager({
      credentials: [credA],
      discovery: {
        discoverForReconnect: async () =>
          makeDiscoveryResult({ instanceId: 'a-instance' }),
        discoverForFirstPair: async () => {
          firstPairAttempted = true
          return [makeDiscoveryResult({ wsPort: 16805 })]
        },
        ensureNonce: async (r) => ({ ...r, nonce: 'fresh-nonce' }),
      },
      reconnectOutcomes: {
        'cred-a': new ReconnectFlowError('authFailed', 'bad mac'),
      },
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(firstPairAttempted).toBe(false)
    expect(mgr.getState()).toBe('disconnected')
    expect(mgr.lastConnectUrl).toBe('ws://127.0.0.1:16802/v1')
  })

  // H1: the exact scenario an unattended MV3 wake reproduces — a stored
  // credential that no longer authenticates (Motrix restarted, or the user
  // revoked pairing from Motrix's own UI while the worker was asleep) must
  // NOT put an unrequested approval dialog on the user's Motrix. §6.7/§12
  // require fresh code-entry pairing to wait for the user or an explicit
  // revocation; an unattended attempt that exhausts the recovery order must
  // land in `disconnected` instead, with the retained credential untouched.
  it('does NOT fall back to first-pair once the recovery order is exhausted — unattended', async () => {
    const credA = makeStoredCredential('cred-a')
    let firstPairAttempted = false
    const mgr = makeManager({
      credentials: [credA],
      discovery: {
        discoverForReconnect: async () =>
          makeDiscoveryResult({ instanceId: 'a-instance' }),
        discoverForFirstPair: async () => {
          firstPairAttempted = true
          return [makeDiscoveryResult({ wsPort: 16805 })]
        },
        ensureNonce: async (r) => ({ ...r, nonce: 'fresh-nonce' }),
      },
      reconnectOutcomes: {
        'cred-a': new ReconnectFlowError('authFailed', 'bad mac'),
      },
    })

    await mgr.connect({ allowLaunch: false, userInitiated: false })

    expect(firstPairAttempted).toBe(false)
    // The reconnect attempt itself did run (and failed) — only the fallback
    // to /pair must be refused.
    expect(mgr.lastConnectUrl).not.toContain('/pair')
    expect(mgr.getState()).toBe('disconnected')
    expect(mgr.getLastErrorReason()).toBe('recoveryExhaustedUnattended')
  })
})

describe('ConnectionManager MBP1 — first-pair discovery failure', () => {
  it('lands cleanly in disconnected, with no reconnect storm, when discovery finds nothing', async () => {
    const states: ConnectionState[] = []
    const mgr = makeManager({
      discovery: { discoverForFirstPair: async () => [] },
    })
    mgr.onStateChange((s) => states.push(s))

    await mgr.connect({ allowLaunch: true, userInitiated: true })
    await new Promise((r) => setTimeout(r, 20))

    expect(mgr.getState()).toBe('disconnected')
    expect(states).not.toContain('reconnecting')
    expect(mgr.getLastError()).toMatch(/no motrix instance found/i)
  })

  it('clears the previous verdict once a superseding attempt proceeds', async () => {
    let calls = 0
    const mgr = makeManager({
      discovery: {
        discoverForFirstPair: async () => {
          calls += 1
          if (calls === 1) return []
          // The second attempt hangs in flight — exactly the window where
          // the dialog showed its predecessor's failure beside a live
          // pairing prompt.
          return new Promise(() => {})
        },
      },
    })
    await mgr.connect({ allowLaunch: true, userInitiated: true })
    await new Promise((r) => setTimeout(r, 20))
    expect(mgr.getLastError()).toMatch(/no motrix instance found/i)

    void mgr.connect({ allowLaunch: true, userInitiated: true })
    await new Promise((r) => setTimeout(r, 20))
    // lastError describes the most recent COMPLETED attempt; an attempt
    // that has been superseded by a live one no longer owns the display.
    expect(mgr.getLastError()).toBeNull()
    expect(mgr.getLastErrorReason()).toBeNull()
  })
})

describe('ConnectionManager MBP1 — awaiting-code state', () => {
  const CODE_REQUEST = {
    instanceId: 'i-1',
    timeoutMs: 120_000,
    run: 1,
    attemptsRemaining: null,
  }

  /** A flow double that actually consults the code source, so the manager's
   *  provider wrapper (the state-machine seam under test) is exercised. */
  const DISCOVERY = {
    discoverForFirstPair: async () => [makeDiscoveryResult({ wsPort: 16802 })],
    ensureNonce: async (r: DiscoveryResult) => ({ ...r, nonce: 'fresh-nonce' }),
  }

  function codeAwareFlow(onFlowCreated?: () => void) {
    return () => {
      onFlowCreated?.()
      return {
        run: async (args: PairingFlowRunArgs) => {
          await (args.code as PairingCodeProvider)(CODE_REQUEST)
          return {
            credentialId: 'fresh-credential',
            envelope: fakeEnvelope(),
            instanceId: 'i-1',
          }
        },
      }
    }
  }

  it('enters awaiting-code at the provider and leaves through handshaking to connected', async () => {
    const states: ConnectionState[] = []
    let resolveCode: ((code: string) => void) | null = null
    const mgr = makeManager({
      discovery: DISCOVERY,
      pairingCodeSource: () =>
        new Promise<string>((resolve) => {
          resolveCode = resolve
        }),
      createPairingFlow: codeAwareFlow(),
    })
    mgr.onStateChange((s) => states.push(s))
    void mgr.connect({ allowLaunch: true, userInitiated: true })
    await new Promise((r) => setTimeout(r, 20))

    expect(mgr.getState()).toBe('awaiting-code')
    expect(mgr.getPendingPairingCode()?.request).toEqual(CODE_REQUEST)

    resolveCode?.('MTX7K2Q9')
    await new Promise((r) => setTimeout(r, 20))

    expect(mgr.getState()).toBe('connected')
    expect(mgr.getPendingPairingCode()).toBeNull()
    const enteredAt = states.indexOf('awaiting-code')
    expect(enteredAt).toBeGreaterThan(-1)
    expect(states[enteredAt + 1]).toBe('handshaking')
  })

  it('coalesces overlapping explicit intents before the first flow reaches code entry', async () => {
    let flows = 0
    let markFlowEntered!: () => void
    let releaseFlow!: () => void
    const flowEntered = new Promise<void>((resolve) => {
      markFlowEntered = resolve
    })
    const flowBlocked = new Promise<void>((resolve) => {
      releaseFlow = resolve
    })
    const mgr = makeManager({
      discovery: DISCOVERY,
      createPairingFlow: () => ({
        run: async () => {
          flows += 1
          markFlowEntered()
          await flowBlocked
          return {
            credentialId: 'fresh-credential',
            envelope: fakeEnvelope(),
            instanceId: 'i-1',
          }
        },
      }),
    })

    const endpointActivation = mgr.clearGateAndStart()
    await flowEntered
    expect(mgr.getState()).toBe('connecting')

    // Endpoint activation starts pairing asynchronously. If the Options Pair
    // button lands before PairingFlow asks for the code, both entry points
    // must join one intent. Restarting here closes a prompt the Server may
    // already have queued, which correctly burns a §7.3 failure and locks the
    // replacement attempt out.
    const pairButton = mgr.clearGateAndStart()
    expect(pairButton).toBe(endpointActivation)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(flows).toBe(1)

    releaseFlow()
    await Promise.all([endpointActivation, pairButton])
    expect(mgr.getState()).toBe('connected')
  })

  it('invalidates the explicit flight at an endpoint lifecycle stop', async () => {
    const releases: Array<() => void> = []
    const mgr = makeManager({
      discovery: DISCOVERY,
      createPairingFlow: () => ({
        run: async () => {
          await new Promise<void>((resolve) => {
            releases.push(resolve)
          })
          return {
            credentialId: 'fresh-credential',
            envelope: fakeEnvelope(),
            instanceId: 'i-1',
          }
        },
      }),
    })

    const retiredEndpoint = mgr.clearGateAndStart()
    await vi.waitFor(() => expect(releases).toHaveLength(1))

    mgr.stopForEndpointChange()
    const replacementEndpoint = mgr.clearGateAndStart()
    expect(replacementEndpoint).not.toBe(retiredEndpoint)
    await vi.waitFor(() => expect(releases).toHaveLength(2))

    releases[1]?.()
    await replacementEndpoint
    expect(mgr.getState()).toBe('connected')

    releases[0]?.()
    await retiredEndpoint
    expect(mgr.getState()).toBe('connected')
  })

  it('keeps an attempt awaiting the pairing code instead of restarting it', async () => {
    let flows = 0
    const mgr = makeManager({
      discovery: DISCOVERY,
      pairingCodeSource: () => new Promise<string>(() => {}),
      createPairingFlow: codeAwareFlow(() => {
        flows += 1
      }),
    })
    void mgr.connect({ allowLaunch: true, userInitiated: true })
    await new Promise((r) => setTimeout(r, 20))
    expect(mgr.getState()).toBe('awaiting-code')

    // A second entry point (options "Pair", popup "Connect") fires while
    // the user is mid-code-entry: it must adopt the live prompt, not
    // torpedo it and burn another §7.3 server admission.
    await mgr.clearGateAndStart()
    await new Promise((r) => setTimeout(r, 20))

    expect(flows).toBe(1)
    expect(mgr.getState()).toBe('awaiting-code')
  })

  it('hides the pending prompt the moment the attempt is stopped', async () => {
    const channel = makeFakeChannel()
    const close = vi.spyOn(channel, 'close')
    const mgr = makeManager({
      discovery: DISCOVERY,
      pairingCodeSource: () => new Promise<string>(() => {}),
      createPairingFlow: codeAwareFlow(),
      createFrameChannel: () => channel,
    })
    void mgr.connect({ allowLaunch: true, userInitiated: true })
    await new Promise((r) => setTimeout(r, 20))
    expect(mgr.getPendingPairingCode()).not.toBeNull()

    mgr.stop()

    // stop owns the pre-auth socket too; it must not wait for the provider's
    // two-minute code TTL to release the channel.
    expect(close).toHaveBeenCalledTimes(1)
    // The provider promise itself cannot be cancelled (§7.2's timeout will
    // reap it), but the prompt must vanish from every surface at once.
    expect(mgr.getPendingPairingCode()).toBeNull()
  })

  it('does not let a stopped provider clear a replacement attempt prompt', async () => {
    const codeResolvers: Array<(code: string) => void> = []
    const mgr = makeManager({
      discovery: DISCOVERY,
      pairingCodeSource: () =>
        new Promise<string>((resolve) => {
          codeResolvers.push(resolve)
        }),
      createPairingFlow: codeAwareFlow(),
    })

    const first = mgr.connect({ allowLaunch: true, userInitiated: true })
    await vi.waitFor(() => expect(codeResolvers).toHaveLength(1))
    expect(mgr.getState()).toBe('awaiting-code')

    mgr.stop()
    const replacement = mgr.connect({ allowLaunch: true, userInitiated: true })
    await vi.waitFor(() => expect(codeResolvers).toHaveLength(2))
    expect(mgr.getState()).toBe('awaiting-code')
    const replacementPrompt = mgr.getPendingPairingCode()

    // The first provider has no cancellation primitive. Its late settlement
    // must not clear or advance the replacement attempt that now owns the UI.
    codeResolvers[0]?.('MTX7K2Q9')
    await first
    expect(mgr.getState()).toBe('awaiting-code')
    expect(mgr.getPendingPairingCode()).toBe(replacementPrompt)

    codeResolvers[1]?.('MTX7K2Q9')
    await replacement
    expect(mgr.getState()).toBe('connected')
    expect(mgr.getPendingPairingCode()).toBeNull()
  })

  it('does not hold the lifecycle queue while awaiting code and rejects a late credential write after endpoint switch', async () => {
    const endpointConfigStore = new EndpointConfigStore()
    const server = {
      id: 'server-b',
      name: 'Server B',
      url: 'wss://b.example/bridge',
      revision: 0,
      state: 'ready' as const,
    }
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'local',
      servers: [server],
      cleanupTombstones: [],
    })
    const coordinator = new BackendOperationCoordinator()
    const credentialStore = new CredentialStore()
    const gate = new ConnectionGate()
    const channel = makeFakeChannel()
    const close = vi.spyOn(channel, 'close')
    const createEnvelopeConnection = vi.fn(() => makeFakeConn())
    let resolveCode!: (code: string) => void
    let lateWriteError: unknown = null

    const mgr = makeManager({
      endpointConfigStore,
      backendOperationCoordinator: coordinator,
      credentialStore,
      gate,
      discovery: DISCOVERY,
      pairingCodeSource: () =>
        new Promise<string>((resolve) => {
          resolveCode = resolve
        }),
      createFrameChannel: () => channel,
      createPairingFlow: (deps) => ({
        run: async (args: PairingFlowRunArgs) => {
          await (args.code as PairingCodeProvider)(CODE_REQUEST)
          try {
            await resolveCredentialLifecycleStore(
              deps.creds
            ).writeProvisionalUnacked(
              args.principal,
              { credentialId: 'late-credential', mutualKey: 'late-key' },
              null
            )
          } catch (error) {
            lateWriteError = error
          }
          return {
            credentialId: 'late-credential',
            envelope: fakeEnvelope(),
            instanceId: 'late-instance',
          }
        },
      }),
      createEnvelopeConnection,
    })

    const connect = mgr.connect({ allowLaunch: true, userInitiated: true })
    await vi.waitFor(() => expect(mgr.getState()).toBe('awaiting-code'))

    // This is the same serialization order used by catalogue edit/activate:
    // it can acquire the coordinator and stop the attempt while the human is
    // still reading the code prompt.
    await coordinator.run(async () => {
      mgr.stop()
      await endpointConfigStore.setForTest({
        version: 3,
        activeEndpointId: server.id,
        servers: [server],
        cleanupTombstones: [],
      })
    })
    expect(close).toHaveBeenCalled()

    // A deliberately hostile flow ignores isCurrent after its wait. The
    // manager-issued credential facade must still reject its durable write.
    resolveCode('MTX7K2Q9')
    await connect

    expect(lateWriteError).toBeInstanceOf(Error)
    expect(
      await credentialStore
        .forAuthorityForTest(LOCAL_BACKEND_AUTHORITY)
        .recoverOrder({
          browser: CLIENT_INFO.browser,
          verifiedOrigin: computeVerifiedOrigin(),
          clientInstallationId: await getClientInstallationId(),
        })
    ).toEqual([])
    expect((await gate.get()).reason).toBeNull()
    expect(createEnvelopeConnection).not.toHaveBeenCalled()
    expect(mgr.getState()).toBe('disconnected')
    expect(mgr.getPendingPairingCode()).toBeNull()
  })

  it('serializes a bounded credential write before endpoint retirement', async () => {
    const endpointConfigStore = new EndpointConfigStore()
    const server = {
      id: 'server-b',
      name: 'Server B',
      url: 'wss://b.example/bridge',
      revision: 0,
      state: 'ready' as const,
    }
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'local',
      servers: [server],
      cleanupTombstones: [],
    })
    const coordinator = new BackendOperationCoordinator()
    const credentialStore = new CredentialStore()
    const events: string[] = []
    let releaseCredentialSet!: () => void
    let credentialSetStarted!: () => void
    const credentialSetStart = new Promise<void>((resolve) => {
      credentialSetStarted = resolve
    })
    const credentialSetBlocked = new Promise<void>((resolve) => {
      releaseCredentialSet = resolve
    })
    const originalSet = browser.storage.local.set
    let blockFirstCredentialSet = true
    browser.storage.local.set = vi.fn(
      async (items: Record<string, unknown>) => {
        if (
          blockFirstCredentialSet &&
          Object.hasOwn(items, 'motrix.mbp1.credentials')
        ) {
          blockFirstCredentialSet = false
          events.push('credential-set-start')
          credentialSetStarted()
          await credentialSetBlocked
          await originalSet(items)
          events.push('credential-set-done')
          return
        }
        await originalSet(items)
      }
    )

    const channel = makeFakeChannel()
    vi.spyOn(channel, 'close').mockImplementation(() => {
      events.push('preauth-close')
    })
    const mgr = makeManager({
      endpointConfigStore,
      backendOperationCoordinator: coordinator,
      credentialStore,
      discovery: DISCOVERY,
      createFrameChannel: () => channel,
      createPairingFlow: (deps) => ({
        run: async (args: PairingFlowRunArgs) => {
          await resolveCredentialLifecycleStore(
            deps.creds
          ).writeProvisionalUnacked(
            args.principal,
            { credentialId: 'bounded-credential', mutualKey: 'bounded-key' },
            null
          )
          return {
            credentialId: 'bounded-credential',
            envelope: fakeEnvelope(),
            instanceId: 'bounded-instance',
          }
        },
      }),
    })

    const connect = mgr.connect({ allowLaunch: true, userInitiated: true })
    await credentialSetStart

    let retirementSettled = false
    const retirement = coordinator
      .run(async () => {
        mgr.stop()
        await endpointConfigStore.setForTest({
          version: 3,
          activeEndpointId: server.id,
          servers: [server],
          cleanupTombstones: [],
        })
        await credentialStore.revokeAuthority(LOCAL_BACKEND_AUTHORITY)
        events.push('retire')
      })
      .then(() => {
        retirementSettled = true
      })
    await Promise.resolve()

    expect(retirementSettled).toBe(false)
    expect(events).toEqual(['credential-set-start'])

    releaseCredentialSet()
    await retirement
    await connect

    expect(events.indexOf('credential-set-done')).toBeLessThan(
      events.indexOf('preauth-close')
    )
    expect(events.indexOf('preauth-close')).toBeLessThan(
      events.indexOf('retire')
    )
    expect(
      await credentialStore
        .forAuthorityForTest(LOCAL_BACKEND_AUTHORITY)
        .recoverOrder({
          browser: CLIENT_INFO.browser,
          verifiedOrigin: computeVerifiedOrigin(),
          clientInstallationId: await getClientInstallationId(),
        })
    ).toEqual([])
    expect(mgr.getState()).toBe('disconnected')
  })
})

describe('ConnectionManager MBP1 — reconnect lifecycle races', () => {
  it('stops a handleClose reconnect immediately and rejects its late write after endpoint switch', async () => {
    const principal: Principal = {
      browser: CLIENT_INFO.browser,
      verifiedOrigin: computeVerifiedOrigin(),
      clientInstallationId: await getClientInstallationId(),
    }
    const credentialStore = new CredentialStore()
    await credentialStore.writeProvisionalUnacked(principal, {
      credentialId: 'existing-credential',
      mutualKey: 'existing-key',
    })
    await credentialStore.commitAndActivate('existing-credential', principal)

    const endpointConfigStore = new EndpointConfigStore()
    const server = {
      id: 'server-b',
      name: 'Server B',
      url: 'wss://b.example/bridge',
      revision: 0,
      state: 'ready' as const,
    }
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'local',
      servers: [server],
      cleanupTombstones: [],
    })
    const coordinator = new BackendOperationCoordinator()

    let firstSocketClose: (() => void) | null = null
    const firstSocket = {
      addEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === 'close') firstSocketClose = listener
      }),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket
    const firstChannel = makeFakeChannel()
    firstChannel.release = () => ({ socket: firstSocket, queuedFrames: [] })
    const secondChannel = makeFakeChannel()
    const secondClose = vi.spyOn(secondChannel, 'close')
    const channels = [firstChannel, secondChannel]
    let channelIndex = 0

    let releaseSecondRun!: () => void
    let secondRunStarted!: () => void
    const secondRunStart = new Promise<void>((resolve) => {
      secondRunStarted = resolve
    })
    const secondRunBlocked = new Promise<void>((resolve) => {
      releaseSecondRun = resolve
    })
    let runIndex = 0
    let lateWriteError: unknown = null
    const createEnvelopeConnection = vi.fn(() => makeFakeConn())
    const mgr = makeManager({
      endpointConfigStore,
      backendOperationCoordinator: coordinator,
      credentialStore,
      pins: {},
      discovery: {
        discoverForReconnect: async () =>
          makeDiscoveryResult({ instanceId: 'existing-instance' }),
      },
      createFrameChannel: () => channels[channelIndex++] ?? secondChannel,
      createReconnectFlow: (deps) => ({
        run: async () => {
          const index = runIndex++
          if (index === 0) {
            return { envelope: fakeEnvelope() }
          }
          secondRunStarted()
          await secondRunBlocked
          try {
            await resolveCredentialLifecycleStore(
              deps.creds
            ).writeProvisionalUnacked(
              principal,
              { credentialId: 'late-reconnect-write', mutualKey: 'late-key' },
              null
            )
          } catch (error) {
            lateWriteError = error
          }
          return { envelope: fakeEnvelope() }
        },
      }),
      createEnvelopeConnection,
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })
    expect(mgr.getState()).toBe('connected')

    firstSocketClose?.()
    await secondRunStart

    // Model the catalogue's before-change stop and active-profile switch.
    // It must complete without waiting for the reconnect flow's network wait.
    await coordinator.run(async () => {
      mgr.stop()
      await endpointConfigStore.setForTest({
        version: 3,
        activeEndpointId: server.id,
        servers: [server],
        cleanupTombstones: [],
      })
    })
    expect(secondClose).toHaveBeenCalled()

    releaseSecondRun()
    await vi.waitFor(() => expect(lateWriteError).toBeInstanceOf(Error))

    expect(
      (await credentialStore.recoverOrder(principal)).map(
        ({ credentialId }) => credentialId
      )
    ).toEqual(['existing-credential'])
    expect(createEnvelopeConnection).toHaveBeenCalledTimes(1)
    expect(runIndex).toBe(2)
    expect(mgr.getState()).toBe('disconnected')

    // A duplicate queued close from A cannot start a third attempt after B
    // became active.
    firstSocketClose?.()
    await Promise.resolve()
    expect(runIndex).toBe(2)
  })
})

describe('ConnectionManager MBP1 — terminal lifecycle races', () => {
  it('does not persist a late denial after an endpoint change has stopped the attempt', async () => {
    const endpointConfigStore = new EndpointConfigStore()
    const server = {
      id: 'server-b',
      name: 'Server B',
      url: 'wss://b.example/bridge',
      revision: 0,
      state: 'ready' as const,
    }
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'local',
      servers: [server],
      cleanupTombstones: [],
    })
    const coordinator = new BackendOperationCoordinator()
    const gate = new ConnectionGate()
    const channel = makeFakeChannel()
    const close = vi.spyOn(channel, 'close')
    let rejectFlow!: (error: Error) => void
    let flowStarted!: () => void
    const flowStart = new Promise<void>((resolve) => {
      flowStarted = resolve
    })
    const flowResult = new Promise<never>((_resolve, reject) => {
      rejectFlow = reject
    })
    const mgr = makeManager({
      endpointConfigStore,
      backendOperationCoordinator: coordinator,
      gate,
      discovery: {
        discoverForFirstPair: async () => [makeDiscoveryResult()],
        ensureNonce: async (result) => ({ ...result, nonce: 'nonce' }),
      },
      createFrameChannel: () => channel,
      createPairingFlow: () => ({
        run: async () => {
          flowStarted()
          return await flowResult
        },
      }),
    })

    const connect = mgr.connect({ allowLaunch: true, userInitiated: true })
    await flowStart

    let releaseEndpointChange!: () => void
    let endpointChangeEntered!: () => void
    const endpointChangeGate = new Promise<void>((resolve) => {
      releaseEndpointChange = resolve
    })
    const endpointChangeStart = new Promise<void>((resolve) => {
      endpointChangeEntered = resolve
    })
    const endpointChange = coordinator.run(async () => {
      endpointChangeEntered()
      await endpointChangeGate
      mgr.stop()
      await endpointConfigStore.setForTest({
        version: 3,
        activeEndpointId: server.id,
        servers: [server],
        cleanupTombstones: [],
      })
    })
    await endpointChangeStart

    const denial = new PairingFlowError('peerRejected', 'operator denied', {
      pairErrorCode: 'denied',
    })
    rejectFlow(denial)
    await vi.waitFor(() => expect(mgr.getState()).toBe('denied'))

    // enterDenied has queued its durable pause behind the catalogue change.
    // The change wins, invalidates the generation/incarnation, and the stale
    // pause must fail closed instead of marking either endpoint denied.
    releaseEndpointChange()
    await endpointChange
    await connect

    expect(close).toHaveBeenCalled()
    expect((await gate.get()).reason).toBeNull()
    expect(mgr.getState()).toBe('disconnected')
  })

  it('does not revoke credentials or persist denial when endpoint change wins a queued revocation cleanup', async () => {
    const principal: Principal = {
      browser: CLIENT_INFO.browser,
      verifiedOrigin: computeVerifiedOrigin(),
      clientInstallationId: await getClientInstallationId(),
    }
    const credentialStore = new CredentialStore()
    await credentialStore.writeProvisionalUnacked(principal, {
      credentialId: 'still-valid-for-local',
      mutualKey: 'existing-key',
    })
    await credentialStore.commitAndActivate('still-valid-for-local', principal)
    const endpointConfigStore = new EndpointConfigStore()
    const server = {
      id: 'server-b',
      name: 'Server B',
      url: 'wss://b.example/bridge',
      revision: 0,
      state: 'ready' as const,
    }
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'local',
      servers: [server],
      cleanupTombstones: [],
    })
    const coordinator = new BackendOperationCoordinator()
    const gate = new ConnectionGate()
    let revokedHandler: ((params: { reason: string }) => void) | null = null
    const conn = makeFakeConn()
    vi.mocked(conn.onNotification).mockImplementation(
      (name: string, handler: unknown) => {
        if (name === '$/pair/revoked') {
          revokedHandler = handler as (params: { reason: string }) => void
        }
      }
    )
    const mgr = makeManager({
      endpointConfigStore,
      backendOperationCoordinator: coordinator,
      credentialStore,
      gate,
      discovery: {
        discoverForReconnect: async () =>
          makeDiscoveryResult({ instanceId: 'local-instance' }),
      },
      reconnectOutcomes: {
        'still-valid-for-local': { envelope: fakeEnvelope() },
      },
      createEnvelopeConnection: () => conn,
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })
    expect(mgr.getState()).toBe('connected')
    expect(revokedHandler).not.toBeNull()

    let releaseEndpointChange!: () => void
    let endpointChangeEntered!: () => void
    const endpointChangeGate = new Promise<void>((resolve) => {
      releaseEndpointChange = resolve
    })
    const endpointChangeStart = new Promise<void>((resolve) => {
      endpointChangeEntered = resolve
    })
    const endpointChange = coordinator.run(async () => {
      endpointChangeEntered()
      await endpointChangeGate
      mgr.stop()
      await endpointConfigStore.setForTest({
        version: 3,
        activeEndpointId: server.id,
        servers: [server],
        cleanupTombstones: [],
      })
    })
    await endpointChangeStart

    revokedHandler?.({ reason: 'late-revoke' })
    expect(mgr.getState()).toBe('denied')
    const cleanup = (
      mgr as unknown as { pendingRevocationCleanup: Promise<void> | null }
    ).pendingRevocationCleanup
    expect(cleanup).not.toBeNull()

    releaseEndpointChange()
    await endpointChange
    await cleanup

    expect(
      (await credentialStore.recoverOrder(principal)).map(
        ({ credentialId }) => credentialId
      )
    ).toEqual(['still-valid-for-local'])
    expect((await gate.get()).reason).toBeNull()
    expect(mgr.getState()).toBe('disconnected')
  })
})

describe('ConnectionManager MBP1 — degraded (no native-host attestation)', () => {
  it('is null before any first-pair attempt has run this session', () => {
    const mgr = makeManager()
    expect(mgr.getDegraded()).toBeNull()
  })

  it('is true once a first-pair candidate answers with no nmTicket at all', async () => {
    const mgr = makeManager({
      discovery: {
        discoverForFirstPair: async () => [makeDiscoveryResult()],
        ensureNonce: async (r) => ({ ...r, nonce: 'n' }), // no nmTicket
      },
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('connected')
    expect(mgr.getDegraded()).toBe(true)
  })

  it('is false once a first-pair candidate answers with an nmTicket', async () => {
    const mgr = makeManager({
      discovery: {
        discoverForFirstPair: async () => [makeDiscoveryResult()],
        ensureNonce: async (r) => ({
          ...r,
          nonce: 'n',
          nmTicket: { generation: 1 },
        }),
      },
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('connected')
    expect(mgr.getDegraded()).toBe(false)
  })

  it('stays null after a plain reconnect — that path never re-presents a ticket', async () => {
    const credential = makeStoredCredential('cred-1')
    const mgr = makeManager({
      credentials: [credential],
      pins: { 'cred-1': { port: 16802, instanceId: 'pinned-instance' } },
      discovery: {
        discoverForReconnect: async () => makeDiscoveryResult(),
      },
      reconnectOutcomes: { 'cred-1': { envelope: fakeEnvelope() } },
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('connected')
    expect(mgr.getDegraded()).toBeNull()
  })

  it('resets to null on stop(), rather than leaking into the next session', async () => {
    const mgr = makeManager({
      discovery: {
        discoverForFirstPair: async () => [makeDiscoveryResult()],
        ensureNonce: async (r) => ({ ...r, nonce: 'n' }),
      },
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })
    expect(mgr.getDegraded()).toBe(true)

    mgr.stop()

    expect(mgr.getDegraded()).toBeNull()
  })
})

describe('ConnectionManager MBP1 — ticket bootstrap wiring', () => {
  it('threads one binding keypair from discovery into a ticketed PairingFlow', async () => {
    let bindingPubSent: Uint8Array | undefined
    let pairingArgs: PairingFlowRunArgs | undefined
    const ticket = { v: 1, purpose: 'mbp1-attestation' }
    const mgr = makeManager({
      discovery: {
        discoverForFirstPair: async (opts) => {
          bindingPubSent = opts.bindingPub
          return [
            makeDiscoveryResult({
              transport: 'nm',
              nonce: 'n',
              nmTicket: ticket,
            }),
          ]
        },
      },
      onPairingRun: (args) => {
        pairingArgs = args
      },
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(bindingPubSent).toBeInstanceOf(Uint8Array)
    expect(bindingPubSent).toHaveLength(32)
    expect(pairingArgs?.bindingKeypair?.pub).toEqual(bindingPubSent)
    expect(pairingArgs?.nmTicket).toBeUndefined()
    expect(pairingArgs?.discovery.nmTicket).toBe(ticket)
  })

  it('drops the keypair when the host degrades to ticketless', async () => {
    let bindingPubSent: Uint8Array | undefined
    let pairingArgs: PairingFlowRunArgs | undefined
    const mgr = makeManager({
      discovery: {
        discoverForFirstPair: async (opts) => {
          bindingPubSent = opts.bindingPub
          return [
            makeDiscoveryResult({
              transport: 'nm',
              nonce: 'n',
            }),
          ]
        },
      },
      onPairingRun: (args) => {
        pairingArgs = args
      },
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(bindingPubSent).toHaveLength(32)
    expect(pairingArgs).toBeDefined()
    expect('bindingKeypair' in (pairingArgs ?? {})).toBe(false)
    expect(mgr.getDegraded()).toBe(true)
  })
})

describe('ConnectionManager MBP1 — backend compatibility preflight', () => {
  it.each([
    ['backendUpgradeRequired', 'backendUpgradeRequired'],
    ['extensionUpgradeRequired', 'extensionUpgradeRequired'],
    [undefined, 'backendUpgradeRequired'],
  ] as const)(
    'fails before nonce use for compatibility=%s',
    async (compatibility, expectedReason) => {
      const ensureNonce = vi.fn(async (r: DiscoveryResult) => ({
        ...r,
        nonce: 'must-not-be-used',
      }))
      let pairingRuns = 0
      const candidate: DiscoveryResult = {
        transport: 'probe',
        wsPort: 16802,
        ...(compatibility === undefined ? {} : { compatibility }),
      }
      const mgr = makeManager({
        discovery: {
          discoverForFirstPair: async () => [candidate],
          preflightCompatibility: async (result) => result,
          ensureNonce,
        },
        onPairingRun: () => {
          pairingRuns += 1
        },
      })

      await mgr.connect({ allowLaunch: true, userInitiated: true })

      expect(mgr.getState()).toBe('disconnected')
      expect(mgr.getLastErrorReason()).toBe(expectedReason)
      expect(ensureNonce).not.toHaveBeenCalled()
      expect(pairingRuns).toBe(0)
      expect(mgr.lastConnectUrl).toBeNull()
    }
  )
})

describe('ConnectionManager MBP1 — envelope wiring', () => {
  it('hands createEnvelopeConnection the exact envelope a successful reconnect returned', async () => {
    const credential = makeStoredCredential('cred-1')
    const envelope = fakeEnvelope()
    const socket = fakeSocket()
    const seenArgs: { socket: WebSocket; envelope: EnvelopeCodec }[] = []
    const mgr = makeManager({
      credentials: [credential],
      pins: { 'cred-1': { port: 16802, instanceId: 'pinned-instance' } },
      discovery: {
        discoverForReconnect: async () => makeDiscoveryResult(),
      },
      reconnectOutcomes: { 'cred-1': { envelope } },
      createFrameChannel: () => ({
        ...makeFakeChannel(),
        release: () => ({ socket, queuedFrames: [] }),
      }),
      createEnvelopeConnection: (s, e) => {
        seenArgs.push({ socket: s, envelope: e })
        return makeFakeConn()
      },
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('connected')
    expect(seenArgs).toHaveLength(1)
    expect(seenArgs[0]?.envelope).toBe(envelope)
    expect(seenArgs[0]?.socket).toBe(socket)
  })

  it('hands createEnvelopeConnection the exact envelope a successful first pairing returned', async () => {
    const envelope = fakeEnvelope()
    const socket = fakeSocket()
    const seenArgs: { socket: WebSocket; envelope: EnvelopeCodec }[] = []
    const mgr = makeManager({
      discovery: {
        discoverForFirstPair: async () => [makeDiscoveryResult()],
        ensureNonce: async (r) => ({ ...r, nonce: 'n' }),
      },
      pairingOutcome: {
        credentialId: 'fresh-credential',
        envelope,
        instanceId: 'fresh-instance',
      },
      createFrameChannel: () => ({
        ...makeFakeChannel(),
        release: () => ({ socket, queuedFrames: [] }),
      }),
      createEnvelopeConnection: (s, e) => {
        seenArgs.push({ socket: s, envelope: e })
        return makeFakeConn()
      },
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('connected')
    expect(seenArgs).toHaveLength(1)
    expect(seenArgs[0]?.envelope).toBe(envelope)
    expect(seenArgs[0]?.socket).toBe(socket)
  })
})

describe('ConnectionManager MBP1 — closes the channel on a post-flow.run() failure', () => {
  // `flow.run()` succeeding hands `channel` back still open and unowned —
  // neither PairingFlow nor ReconnectFlow closes it on success. A throw
  // anywhere between that point and a completed `finishMbp1Connection`
  // (release() itself rejecting a queued text frame, or the attempt going
  // stale) must not leak the live socket.
  it('closes the channel when release() rejects a queued text frame during first-pair', async () => {
    const close = vi.fn()
    const mgr = makeManager({
      discovery: {
        discoverForFirstPair: async () => [makeDiscoveryResult()],
        ensureNonce: async (r) => ({ ...r, nonce: 'n' }),
      },
      pairingOutcome: {
        credentialId: 'fresh-credential',
        envelope: fakeEnvelope(),
        instanceId: 'fresh-instance',
      },
      createFrameChannel: () => ({
        ...makeFakeChannel(),
        close,
        release: () => {
          throw new Error('§6.1 violation: a text frame is still queued')
        },
      }),
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('disconnected')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes the channel when release() rejects a queued text frame during reconnect', async () => {
    const close = vi.fn()
    const credential = makeStoredCredential('cred-1')
    const mgr = makeManager({
      credentials: [credential],
      pins: { 'cred-1': { port: 16802, instanceId: 'pinned-instance' } },
      discovery: {
        discoverForReconnect: async () => makeDiscoveryResult(),
      },
      reconnectOutcomes: { 'cred-1': { envelope: fakeEnvelope() } },
      createFrameChannel: () => ({
        ...makeFakeChannel(),
        close,
        release: () => {
          throw new Error('§6.1 violation: a text frame is still queued')
        },
      }),
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(mgr.getState()).toBe('disconnected')
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('ConnectionManager MBP1 — autostart with a stored credential', () => {
  // autostart() is a background SW-startup probe: it must never wake
  // Motrix (`allowLaunch: false`) and it never speaks for the user
  // (`userInitiated: false`, so an exhausted recovery order lands in
  // disconnected rather than falling back to fresh pairing). Both
  // guarantees are also covered by the exhausted-order test below: an
  // autostart retry may recover but cannot fall through to fresh pairing.
  it('keeps the lifecycle queue available during a slow startup initialize', async () => {
    vi.useFakeTimers()
    const coordinator = new BackendOperationCoordinator()
    const conn = makeFakeConn()
    const reply = await conn.sendRequest(Methods.MotrixInitialize, {} as never)
    let finishInitialize!: (value: unknown) => void
    vi.mocked(conn.sendRequest).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishInitialize = resolve
        }) as never
    )
    const mgr = makeManager({
      credentials: [makeStoredCredential('cred-1')],
      pins: { 'cred-1': { port: 16802, instanceId: 'pinned-instance' } },
      discovery: { discoverForReconnect: async () => makeDiscoveryResult() },
      reconnectOutcomes: { 'cred-1': { envelope: fakeEnvelope() } },
      backendOperationCoordinator: coordinator,
      createEnvelopeConnection: () => conn,
    })
    try {
      const completed = vi.fn()
      const startup = mgr.autostart().then(completed)
      await vi.advanceTimersByTimeAsync(0)
      expect(finishInitialize).toBeTypeOf('function')
      expect(mgr.getState()).not.toBe('connected')
      const read = vi.fn()
      void coordinator.run(async () => mgr.getState()).then(read)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(read).toHaveBeenCalledOnce()
      expect(completed).not.toHaveBeenCalled()
      expect(mgr.getLastAttemptIntent()).toBe('background-probe')
      finishInitialize(reply)
      await startup
      expect(mgr.getState()).toBe('connected')
    } finally {
      mgr.stop()
      vi.useRealTimers()
    }
  })

  it('attempts a reconnect via discoveryService, never NativeBootstrap.discover, when a credential is stored', async () => {
    const credential = makeStoredCredential('cred-1')
    const mgr = makeManager({
      credentials: [credential],
      pins: { 'cred-1': { port: 16802, instanceId: 'pinned-instance' } },
      discovery: {
        discoverForReconnect: async () => makeDiscoveryResult(),
      },
      reconnectOutcomes: { 'cred-1': { envelope: fakeEnvelope() } },
    })
    await mgr.autostart()

    expect(mgr.getState()).toBe('connected')
  })

  it('stays dormant with no discoveryService calls when no credential is stored', async () => {
    const discovery = makeFakeDiscoveryService({})
    const mgr = makeManager({ discoveryService: discovery })
    await mgr.autostart()

    expect(mgr.getState()).toBe('disconnected')
    expect(discovery.discoverForReconnect).not.toHaveBeenCalled()
    expect(discovery.discoverForFirstPair).not.toHaveBeenCalled()
  })

  it('keeps an unpaired remote endpoint dormant without discovery', async () => {
    const endpointConfigStore = new EndpointConfigStore()
    await endpointConfigStore.setForTest({
      version: 3,
      activeEndpointId: 'nas',
      servers: [
        {
          id: 'nas',
          name: 'NAS',
          url: 'wss://nas.local:9090',
          revision: 0,
          state: 'ready',
        },
      ],
      cleanupTombstones: [],
    })
    const client = makeFakeClient()
    vi.mocked(client.connect).mockImplementation(
      async () => makeFakeConn() as never
    )
    const mgr = new ConnectionManager({
      clientInfo: CLIENT_INFO,
      bootstrap: makeFakeBootstrap(),
      client,
      endpointConfigStore,
    })
    await mgr.autostart()

    expect(mgr.getState()).toBe('disconnected')
    expect(mgr.getLastErrorReason()).toBeNull()
    expect(client.connect).not.toHaveBeenCalled()
  })
})

// M5: `ageOutUnacked`/`cleanupFirstPairOrphans` are implemented and unit
// tested on `CredentialStore` in isolation, but had no production caller —
// `pairing-flow.ts`'s own comment claimed they were "what clean up" while
// nothing ever ran them. These use a REAL `CredentialStore` (not the fake
// every other describe block here uses) specifically to prove the wiring
// itself, not just that the underlying methods work.
describe('ConnectionManager MBP1 — §6.7 store housekeeping runs on every local connect', () => {
  async function localPrincipal(): Promise<Principal> {
    return {
      browser: CLIENT_INFO.browser,
      verifiedOrigin: computeVerifiedOrigin(),
      clientInstallationId: await getClientInstallationId(),
    }
  }

  it('ages out a stale unacked provisional before the recovery-order walk', async () => {
    const credentialStore = new CredentialStore()
    const principal = await localPrincipal()
    await credentialStore.writeProvisionalUnacked(principal, {
      credentialId: 'stale-unacked',
      mutualKey: 'k',
    })
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000)

    const mgr = makeManager({
      credentialStore,
      discovery: { discoverForFirstPair: async () => [] },
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(await credentialStore.recoverOrder(principal)).toEqual([])
    vi.restoreAllMocks()
  })

  it("drops this principal's own first-pair orphan past the provisional TTL", async () => {
    const credentialStore = new CredentialStore()
    const principal = await localPrincipal()
    await credentialStore.writeProvisionalUnacked(principal, {
      credentialId: 'orphan',
      mutualKey: 'k',
    })
    await credentialStore.markCommitUncertain('orphan')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000)

    const mgr = makeManager({
      credentialStore,
      discovery: { discoverForFirstPair: async () => [] },
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    expect(await credentialStore.recoverOrder(principal)).toEqual([])
    vi.restoreAllMocks()
  })

  it('never touches a commit-uncertain credential this principal has committed', async () => {
    const credentialStore = new CredentialStore()
    const principal = await localPrincipal()
    // A live, committed credential plus its own commit-uncertain rotation
    // successor — the one case neither cleanup method may ever remove,
    // since only an authenticated reconnect can prove which the server
    // actually kept.
    await credentialStore.writeProvisionalUnacked(principal, {
      credentialId: 'committed-1',
      mutualKey: 'k',
    })
    await credentialStore.commitAndActivate('committed-1', principal)
    await credentialStore.writeProvisionalUnacked(principal, {
      credentialId: 'rotation-successor',
      mutualKey: 'k',
    })
    await credentialStore.markCommitUncertain('rotation-successor')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000)

    const mgr = makeManager({
      credentialStore,
      discovery: {
        discoverForReconnect: async () => makeDiscoveryResult(),
      },
      reconnectOutcomes: {
        'committed-1': { envelope: fakeEnvelope() },
      },
    })

    await mgr.connect({ allowLaunch: true, userInitiated: true })

    const ids = (await credentialStore.recoverOrder(principal)).map(
      (c) => c.credentialId
    )
    expect(ids.sort()).toEqual(['committed-1', 'rotation-successor'])
    vi.restoreAllMocks()
  })
})

describe('explicit wake for a retained local pairing', () => {
  it('wakes once, reconnects with the original credential, and never enters first-pair', async () => {
    const wake = vi.fn(
      async () =>
        new Map([['cred-1', makeDiscoveryResult({ instanceId: 'known' })]])
    )
    const firstPair = vi.fn(async () => [])
    const mgr = makeManager({
      credentials: [makeStoredCredential('cred-1')],
      discovery: { wakeForReconnect: wake, discoverForFirstPair: firstPair },
      reconnectOutcomes: { 'cred-1': { envelope: fakeEnvelope() } },
    })
    await mgr.connect({ allowLaunch: true, userInitiated: true })
    expect(wake).toHaveBeenCalledExactlyOnceWith(['cred-1'])
    expect(firstPair).not.toHaveBeenCalled()
    expect(mgr.getState()).toBe('connected')
    expect(mgr.lastConnectUrl).toContain('/v1')
  })

  it.each([
    { allowLaunch: false, userInitiated: true },
    { allowLaunch: true, userInitiated: false },
  ])('does not wake without an explicit launch request: %j', async (flags) => {
    const wake = vi.fn(async () => new Map())
    const firstPair = vi.fn(async () => [])
    const mgr = makeManager({
      credentials: [makeStoredCredential('cred-1')],
      discovery: { wakeForReconnect: wake, discoverForFirstPair: firstPair },
    })
    await mgr.connect(flags)
    expect(wake).not.toHaveBeenCalled()
    expect(firstPair).not.toHaveBeenCalled()
    expect(mgr.getState()).toBe('disconnected')
  })

  it('keeps the retained pairing when wake returns no matching instance', async () => {
    const wake = vi.fn(async () => new Map())
    const firstPair = vi.fn(async () => [])
    const mgr = makeManager({
      credentials: [makeStoredCredential('cred-1')],
      discovery: { wakeForReconnect: wake, discoverForFirstPair: firstPair },
    })
    await mgr.connect({ allowLaunch: true, userInitiated: true })
    expect(wake).toHaveBeenCalledOnce()
    expect(firstPair).not.toHaveBeenCalled()
    expect(mgr.getState()).toBe('disconnected')
  })
})

describe('download readiness intent', () => {
  it('shares one wake between downloads and task viewing without admitting first pairing', async () => {
    let release!: (
      value: Map<string, ReturnType<typeof makeDiscoveryResult>>
    ) => void
    const wake = vi.fn(
      () =>
        new Promise<Map<string, ReturnType<typeof makeDiscoveryResult>>>(
          (done) => {
            release = done
          }
        )
    )
    const firstPair = vi.fn(async () => [])
    const mgr = makeManager({
      credentials: [makeStoredCredential('cred-1')],
      discovery: { wakeForReconnect: wake, discoverForFirstPair: firstPair },
      reconnectOutcomes: { 'cred-1': { envelope: fakeEnvelope() } },
    })
    const first = mgr.ensureReady({ intent: 'explicit-download' })
    const second = mgr.ensureReady({ intent: 'view-tasks' })
    await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce())
    expect(mgr.getConnectionPhase()).toBe('waking')
    release(new Map([['cred-1', makeDiscoveryResult({ instanceId: 'known' })]]))
    await Promise.all([first, second])
    expect(mgr.getState()).toBe('connected')
    expect(firstPair).not.toHaveBeenCalled()
    mgr.stop()
  })

  it('does not clear a denied gate or show a first-pair prompt for a download', async () => {
    const gate = new ConnectionGate()
    await gate.pauseDenied('operator denied')
    const wake = vi.fn(async () => new Map())
    const firstPair = vi.fn(async () => [])
    const mgr = makeManager({
      credentials: [makeStoredCredential('cred-1')],
      discovery: { wakeForReconnect: wake, discoverForFirstPair: firstPair },
    })
    await expect(
      mgr.ensureReady({ intent: 'automatic-download' })
    ).rejects.toThrow('download.connection-failed')
    expect((await gate.get()).reason).toBe('denied')
    expect(wake).not.toHaveBeenCalled()
    expect(firstPair).not.toHaveBeenCalled()
    mgr.stop()
  })

  it('keeps an unpaired download out of first pairing', async () => {
    const firstPair = vi.fn(async () => [])
    const mgr = makeManager({ discovery: { discoverForFirstPair: firstPair } })
    await expect(
      mgr.ensureReady({ intent: 'explicit-download' })
    ).rejects.toThrow('download.pairing-required')
    expect(firstPair).not.toHaveBeenCalled()
    mgr.stop()
  })

  it('lets another waiter finish when a short download deadline expires', async () => {
    let release!: (
      value: Map<string, ReturnType<typeof makeDiscoveryResult>>
    ) => void
    const wake = vi.fn(
      () =>
        new Promise<Map<string, ReturnType<typeof makeDiscoveryResult>>>(
          (done) => {
            release = done
          }
        )
    )
    const mgr = makeManager({
      credentials: [makeStoredCredential('cred-1')],
      discovery: { wakeForReconnect: wake },
      reconnectOutcomes: { 'cred-1': { envelope: fakeEnvelope() } },
    })
    const short = expect(
      mgr.ensureReady({
        intent: 'automatic-download',
        deadlineAt: Date.now() + 50,
      })
    ).rejects.toThrow('download.preparation-timeout')
    const long = mgr.ensureReady({ intent: 'explicit-download' })
    await short
    release(new Map([['cred-1', makeDiscoveryResult({ instanceId: 'known' })]]))
    await long
    expect(wake).toHaveBeenCalledOnce()
    expect(mgr.getState()).toBe('connected')
    mgr.stop()
  })
})

it('retires a wedged MDXP socket and reconnects once with stored credentials without launch or pairing', async () => {
  const oldConn = makeFakeConn()
  const newConn = makeFakeConn()
  const originalSend = vi.mocked(oldConn.sendRequest).getMockImplementation()
  vi.mocked(oldConn.sendRequest).mockImplementation((method, ...args) =>
    method === Methods.MotrixInitialize
      ? originalSend?.(method, ...args)
      : new Promise(() => {})
  )
  const newSend = vi.mocked(newConn.sendRequest).getMockImplementation()
  vi.mocked(newConn.sendRequest).mockImplementation((method, ...args) =>
    method === Methods.TaskList
      ? (Promise.resolve({ tasks: [], total: 0 }) as never)
      : newSend?.(method, ...args)
  )
  const createEnvelopeConnection = vi
    .fn()
    .mockReturnValueOnce(oldConn)
    .mockReturnValueOnce(newConn)
  const wake = vi.fn(async () => new Map())
  const pair = vi.fn()
  const reconnect = vi.fn()
  const mgr = makeManager({
    requestTimeoutMs: 10,
    rpcRecoveryTimeouts: { probeTimeoutMs: 10, retryTimeoutMs: 50 },
    credentials: [makeStoredCredential('recovery-credential')],
    pins: {
      'recovery-credential': { port: 16802, instanceId: 'known-instance' },
    },
    discovery: {
      discoverForReconnect: async () => makeDiscoveryResult(),
      wakeForReconnect: wake,
    },
    reconnectOutcomes: { 'recovery-credential': { envelope: fakeEnvelope() } },
    onPairingRun: pair,
    onReconnectRun: reconnect,
    createEnvelopeConnection,
  })
  await mgr.connect({ allowLaunch: false, userInitiated: false })
  expect(mgr.getState()).toBe('connected')
  await expect(mgr.request(Methods.TaskList, {})).resolves.toEqual({
    tasks: [],
    total: 0,
  })
  expect(oldConn.dispose).toHaveBeenCalledOnce()
  expect(createEnvelopeConnection).toHaveBeenCalledTimes(2)
  expect(reconnect).toHaveBeenCalledTimes(2)
  expect(pair).not.toHaveBeenCalled()
  expect(wake).not.toHaveBeenCalled()
  expect(mgr.getRpcStatus()).toMatchObject({
    health: 'healthy',
    lastError: null,
  })
  mgr.stop()
})

it.each(['probe', 'retry', 'stop'])(
  'keeps recovery bounded when the connection closes during %s',
  async (stage) => {
    const oldConn = makeFakeConn()
    const newConn = makeFakeConn()
    const initialize = vi.mocked(oldConn.sendRequest).getMockImplementation()
    let closeSocket: (() => void) | undefined
    let reads = 0
    vi.mocked(oldConn.sendRequest).mockImplementation((method, ...args) => {
      if (method === Methods.MotrixInitialize)
        return initialize?.(method, ...args)
      if (method === Methods.SystemPing) {
        if (stage === 'retry')
          return Promise.resolve({ ...args[0], recvAt: Date.now() }) as never
        queueMicrotask(() =>
          stage === 'stop' ? manager.stop() : closeSocket?.()
        )
      }
      if (method === Methods.TaskList && ++reads === 2)
        queueMicrotask(() => closeSocket?.())
      return new Promise(() => {})
    })
    const newInitialize = vi.mocked(newConn.sendRequest).getMockImplementation()
    vi.mocked(newConn.sendRequest).mockImplementation((method, ...args) =>
      method === Methods.TaskList
        ? (Promise.resolve({ tasks: [], total: 0 }) as never)
        : newInitialize?.(method, ...args)
    )
    const socket = fakeSocket()
    vi.mocked(socket.addEventListener).mockImplementation((type, listener) => {
      if (type === 'close') closeSocket = listener as () => void
    })
    const first = makeFakeChannel()
    first.release = () => ({ socket, queuedFrames: [] })
    const createFrameChannel = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockImplementation(() => makeFakeChannel())
    const createEnvelopeConnection = vi
      .fn()
      .mockReturnValueOnce(oldConn)
      .mockReturnValueOnce(newConn)
    const wake = vi.fn(async () => new Map())
    const pair = vi.fn()
    const reconnect = vi.fn()
    const manager = makeManager({
      requestTimeoutMs: 10,
      rpcRecoveryTimeouts: { probeTimeoutMs: 20, retryTimeoutMs: 50 },
      credentials: [makeStoredCredential('review-cred')],
      pins: { 'review-cred': { port: 16802, instanceId: 'known' } },
      discovery: {
        discoverForReconnect: async () => makeDiscoveryResult(),
        wakeForReconnect: wake,
      },
      reconnectOutcomes: { 'review-cred': { envelope: fakeEnvelope() } },
      onReconnectRun: reconnect,
      onPairingRun: pair,
      createFrameChannel,
      createEnvelopeConnection,
    })
    try {
      await manager.connect({ allowLaunch: false, userInitiated: false })
      const read = manager.request(Methods.TaskList, {})
      if (stage === 'probe') {
        await expect(read).resolves.toEqual({ tasks: [], total: 0 })
        expect(createEnvelopeConnection).toHaveBeenCalledTimes(2)
        expect(reconnect).toHaveBeenCalledTimes(2)
        expect(manager.getState()).toBe('connected')
        expect(manager.getRpcStatus().health).toBe('healthy')
      } else {
        await expect(read).rejects.toThrow(
          stage === 'stop' ? 'RPC session changed' : 'timed out'
        )
        expect(createEnvelopeConnection).toHaveBeenCalledOnce()
        expect(reconnect).toHaveBeenCalledOnce()
        expect(manager.getState()).toBe('disconnected')
        expect(manager.getRpcStatus().health).toBe(
          stage === 'stop' ? 'healthy' : 'unresponsive'
        )
      }
      expect(wake).not.toHaveBeenCalled()
      expect(pair).not.toHaveBeenCalled()
    } finally {
      manager.stop()
    }
  }
)
