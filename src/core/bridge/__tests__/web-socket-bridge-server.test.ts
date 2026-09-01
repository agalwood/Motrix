import { EventEmitter } from 'node:events'
import type { Browser } from '@core/bridge/bridge-connection'
import type { ReadHandlerDeps } from '@core/bridge/handlers/read-handlers'
import type { WriteHandlerDeps } from '@core/bridge/handlers/write-handlers'
import {
  DIR_C2S,
  DIR_S2C,
  EnvelopeLimitError,
  EnvelopeOpener,
  EnvelopeSealer,
  EnvelopeViolationError,
  MAX_ENVELOPE_FRAMES,
} from '@core/bridge/mbp1/envelope'
import type { TrustedExtensionRegistry } from '@core/bridge/trusted-extension-registry'
import {
  WebSocketBridgeServer,
  WS_CLOSE_ENVELOPE_USAGE_LIMIT,
  WS_CLOSE_INTERNAL_ERROR,
  WS_CLOSE_PROTOCOL_ERROR,
} from '@core/bridge/web-socket-bridge-server'
import type { WebSocketLike } from '@core/bridge/web-socket-message-stream'
import type { ClientIdentity } from '@shared/protocol/bridge'
import { EngineState } from '@shared/types/engine'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest'
import WebSocket from 'ws'
import {
  type Mbp1TestWiring,
  makeMbp1TestWiring,
  makeStatefulFakePairing,
} from './fakes'
import {
  initializeParams,
  mdxpOverChannel,
  pairAndExchange,
} from './mbp1-client'

const EXTENSION_ID = 'wsstextensionidaaaaaaaaaaaaaaaaa'
const ORIGIN = `chrome-extension://${EXTENSION_ID}`

function makeFakeRegistry(): TrustedExtensionRegistry {
  const allow = new Set<string>(['chromium:abc'])
  return {
    load: async () => {},
    has: (id: string, browser: Browser) => allow.has(`${browser}:${id}`),
    add: async () => {},
    remove: async () => {},
    listManifestIds: () => [],
  } as unknown as TrustedExtensionRegistry
}

/** An upgrade attempt, resolving `true` only if the socket actually opened. */
function tryUpgrade(
  port: number,
  path: string,
  opts: { origin?: string; subprotocol?: string } = {}
): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}${path}`,
      opts.subprotocol === undefined ? [] : opts.subprotocol,
      { origin: opts.origin }
    )
    ws.once('open', () => {
      ws.terminate()
      resolve(true)
    })
    ws.once('error', () => resolve(false))
  })
}

describe('WebSocketBridgeServer upgrade gates', () => {
  let server: WebSocketBridgeServer
  let port: number

  async function restartWithIdentityGate(
    canAdmitExtensionIdentity: NonNullable<
      ConstructorParameters<
        typeof WebSocketBridgeServer
      >[0]['canAdmitExtensionIdentity']
    >
  ): Promise<void> {
    await server.stop()
    const mbp1 = await makeMbp1TestWiring([['chromium', EXTENSION_ID]])
    server = new WebSocketBridgeServer({
      pairing: makeStatefulFakePairing(),
      registry: makeFakeRegistry(),
      motrixVersion: '2.0',
      runtime: 'electron',
      ffmpegAvailable: true,
      localToken: 'test-token',
      ...mbp1.options,
      canAdmitExtensionIdentity,
    })
    port = await server.start()
  }

  beforeEach(async () => {
    // Deliberately WITHOUT the six MBP1 options: this is a shell that has not
    // wired MBP1, and both extension routes must fail closed rather than fall
    // back to an unauthenticated surface.
    server = new WebSocketBridgeServer({
      pairing: makeStatefulFakePairing(),
      registry: makeFakeRegistry(),
      motrixVersion: '2.0',
      runtime: 'electron',
      ffmpegAvailable: true,
      localToken: 'test-token',
    })
    port = await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('rejects a non-extension origin', async () => {
    await expect(
      tryUpgrade(port, '/v1', {
        origin: 'https://evil.example',
        subprotocol: 'motrix-bridge.v1',
      })
    ).resolves.toBe(false)
  })

  it('rejects an upgrade without the motrix-bridge.v1 subprotocol', async () => {
    await expect(tryUpgrade(port, '/v1', { origin: ORIGIN })).resolves.toBe(
      false
    )
  })

  it('refuses both extension routes when MBP1 is not wired', async () => {
    // The query is irrelevant on either route now — there is no `?token=` path
    // and no legacy `/pair` identity query left to reach.
    await expect(
      tryUpgrade(port, '/v1?token=bogus', {
        origin: ORIGIN,
        subprotocol: 'motrix-bridge.v1',
      })
    ).resolves.toBe(false)
    await expect(
      tryUpgrade(port, '/pair?nonce=bogus', {
        origin: ORIGIN,
        subprotocol: 'motrix-bridge.v1',
      })
    ).resolves.toBe(false)
  })

  it('rejects an unknown path', async () => {
    await expect(
      tryUpgrade(port, '/nope', {
        origin: ORIGIN,
        subprotocol: 'motrix-bridge.v1',
      })
    ).resolves.toBe(false)
  })

  it('gates /pair before consuming its one-shot nonce', async () => {
    let admissible = false
    const gate = vi.fn(() => admissible)
    await restartWithIdentityGate(gate)
    const nonce = server.issuePairNonce()
    const path = `/pair?nonce=${nonce}`

    await expect(
      tryUpgrade(port, path, {
        origin: ORIGIN,
        subprotocol: 'motrix-bridge.v1',
      })
    ).resolves.toBe(false)
    expect(gate).toHaveBeenLastCalledWith({
      kind: 'extension',
      browser: 'chromium',
      extensionId: EXTENSION_ID,
    })

    admissible = true
    await expect(
      tryUpgrade(port, path, {
        origin: ORIGIN,
        subprotocol: 'motrix-bridge.v1',
      })
    ).resolves.toBe(true)
  })

  it('gates /v1 before spending reconnect admission allowance', async () => {
    let admissible = false
    await restartWithIdentityGate(() => admissible)

    // Ten rejected attempts would exhaust the normal per-Origin allowance if
    // the shell gate ran after reconnect admission.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(
        tryUpgrade(port, '/v1', {
          origin: ORIGIN,
          subprotocol: 'motrix-bridge.v1',
        })
      ).resolves.toBe(false)
    }

    admissible = true
    await expect(
      tryUpgrade(port, '/v1', {
        origin: ORIGIN,
        subprotocol: 'motrix-bridge.v1',
      })
    ).resolves.toBe(true)
  })

  it('fails closed when the shell admission gate throws', async () => {
    await restartWithIdentityGate(() => {
      throw new Error('projection unavailable')
    })

    await expect(
      tryUpgrade(port, `/pair?nonce=${server.issuePairNonce()}`, {
        origin: ORIGIN,
        subprotocol: 'motrix-bridge.v1',
      })
    ).resolves.toBe(false)
  })
})

describe('WebSocketBridgeServer.start() bind guard', () => {
  function makeServer(localToken: string): WebSocketBridgeServer {
    return new WebSocketBridgeServer({
      pairing: makeStatefulFakePairing(),
      registry: makeFakeRegistry(),
      motrixVersion: '2.0',
      runtime: 'electron',
      ffmpegAvailable: true,
      localToken,
    })
  }

  it('binds loopback on an ephemeral port by default (desktop behavior)', async () => {
    const s = makeServer('tok')
    const port = await s.start()
    expect(port).toBeGreaterThan(0)
    await s.stop()
  })

  it('binds a non-loopback host when a token is configured', async () => {
    const s = makeServer('tok')
    const port = await s.start('0.0.0.0', 0)
    expect(port).toBeGreaterThan(0)
    await s.stop()
  })

  it('refuses a non-loopback bind without a token (fail closed)', async () => {
    const s = makeServer('')
    await expect(s.start('0.0.0.0', 0)).rejects.toThrow(/non-loopback|token/i)
    await s.stop()
  })

  it('allows a loopback bind even without a token', async () => {
    const s = makeServer('')
    const port = await s.start('127.0.0.1', 0)
    expect(port).toBeGreaterThan(0)
    await s.stop()
  })
})

// ---------------------------------------------------------------------------
// Helpers shared by the control-plane test
// ---------------------------------------------------------------------------

function makeFakeReadDeps(): ReadHandlerDeps {
  return {
    taskManager: {
      getAll: () => [],
      getById: () => undefined,
    },
    statsAggregator: {
      getStats: () => ({
        totalDownloadSpeed: 0,
        totalUploadSpeed: 0,
        activeTasks: 0,
        waitingTasks: 0,
        stoppedTasks: 0,
      }),
    },
    supervisor: {
      getState: () => EngineState.Ready,
      getFeatureReport: () => null,
    },
  }
}

function makeFakeWriteDeps(
  revealTask?: (taskId: string) => Promise<void>
): WriteHandlerDeps {
  return {
    taskManager: {
      getById: (id) =>
        id === 'task-1'
          ? makeDownloadTask({
              id: 'task-1',
              status: TaskStatus.Completed,
            })
          : undefined,
    },
    pauseTask: async () => {},
    resumeTask: async () => {},
    removeTask: async () => {},
    createTask: async () => ({ taskId: 'new-task' }),
    parseTorrentFileCount: async () => 0,
    ...(revealTask ? { revealTask } : {}),
  }
}

describe('WebSocketBridgeServer – v1 control-plane over WS', () => {
  let server: WebSocketBridgeServer
  let mbp1: Mbp1TestWiring
  let port: number
  let revealTask: Mock<(taskId: string) => Promise<void>>

  beforeEach(async () => {
    mbp1 = await makeMbp1TestWiring([['chromium', EXTENSION_ID]])
    server = new WebSocketBridgeServer({
      pairing: makeStatefulFakePairing(),
      registry: {
        load: async () => {},
        has: () => true,
        add: async () => {},
        remove: async () => {},
        listManifestIds: () => [],
      } as unknown as TrustedExtensionRegistry,
      motrixVersion: '2.0',
      runtime: 'electron',
      ffmpegAvailable: true,
      localToken: 'test-token',
      ...mbp1.options,
    })
    server.registerReadMethods(makeFakeReadDeps())
    revealTask = vi.fn(async (_taskId: string) => {})
    server.registerWriteMethods(makeFakeWriteDeps(revealTask))
    port = await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('exposes the v1 control-plane over a paired extension WS but not download/add', async () => {
    const paired = await pairAndExchange({
      port,
      origin: ORIGIN,
      browser: 'chromium',
      claimedExtensionId: EXTENSION_ID,
      code: () => mbp1.dialogs.latestCode(),
    })
    const conn = mdxpOverChannel(paired.wire, paired.channel)
    const initialized = await conn.sendRequest(
      'motrix/initialize',
      initializeParams(EXTENSION_ID)
    )
    expect(initialized.capabilities.taskReveal).toBe(true)
    conn.sendNotification('motrix/initialized', undefined as never)

    // task/list reaches the dispatcher and returns its shape.
    const list = await conn.sendRequest('task/list', {})
    expect(list).toEqual({ tasks: [], total: 0 })

    // stats/get reaches the dispatcher.
    const stats = await conn.sendRequest('stats/get', {})
    expect(stats).toHaveProperty('activeTasks')

    // task/reveal is a user-gesture method on the paired extension surface.
    await expect(
      conn.sendRequest('task/reveal', { taskId: 'task-1' })
    ).resolves.toEqual({ ok: true })
    expect(revealTask).toHaveBeenCalledWith('task-1')

    // download/add is NOT wired on WS → MethodNotFound (-32601).
    await expect(
      conn.sendRequest('download/add', {
        kind: 'url',
        saveDir: '/tmp',
        uris: ['https://example.com/a.bin'],
      })
    ).rejects.toMatchObject({ code: -32601 })

    conn.dispose()
    paired.wire.ws.close()
  })

  it('round-trips system/ping inside the AEAD channel', async () => {
    const paired = await pairAndExchange({
      port,
      origin: ORIGIN,
      browser: 'chromium',
      claimedExtensionId: EXTENSION_ID,
      code: () => mbp1.dialogs.latestCode(),
    })
    const conn = mdxpOverChannel(paired.wire, paired.channel)

    const before = Date.now()
    const pong = await conn.sendRequest('system/ping', { sentAt: before })
    expect(pong.sentAt).toBe(before)
    expect(pong.recvAt).toBeGreaterThanOrEqual(before)

    conn.dispose()
    paired.wire.ws.close()
  })
})

// ---------------------------------------------------------------------------
// Envelope-fault -> WS close-code wiring
// ---------------------------------------------------------------------------

/**
 * A minimal `WebSocketLike` double, exercised directly against
 * `adoptAuthenticatedSession` rather than through a real upgrade: the fault
 * classification these tests cover lives entirely in what the envelope
 * stream reports and how the wiring maps it to a close code, none of which
 * depends on a real socket or a completed handshake.
 */
class FakeExtensionSocket extends EventEmitter {
  readyState = 1
  readonly closedWith: Array<[number | undefined, string | undefined]> = []
  readonly sent: Array<string | Uint8Array> = []

  send(data: string | Uint8Array): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closedWith.push([code, reason])
    this.readyState = 3
  }

  asLike(): WebSocketLike {
    return this as unknown as WebSocketLike
  }
}

describe('WebSocketBridgeServer.adoptAuthenticatedSession — envelope fault close codes', () => {
  let server: WebSocketBridgeServer
  const KEY = new Uint8Array(32).fill(3)
  const CREDENTIAL_ID = 'credential-used-by-this-transport'
  const IDENTITY = {
    kind: 'extension' as const,
    browser: 'chromium' as const,
    extensionId: EXTENSION_ID,
  }
  let authenticated: Array<{
    identity: ClientIdentity & { kind: 'extension' }
    credentialId: string
  }>

  beforeEach(async () => {
    authenticated = []
    server = new WebSocketBridgeServer({
      pairing: makeStatefulFakePairing(),
      registry: makeFakeRegistry(),
      motrixVersion: '2.0',
      runtime: 'electron',
      ffmpegAvailable: true,
      localToken: 'test-token',
      onExtensionAuthenticated: (identity, credentialId) => {
        authenticated.push({ identity, credentialId })
      },
    })
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('closes with the usage-limit code — not protocol-error or internal-error — when an inbound §10 bound is reached', () => {
    const ws = new FakeExtensionSocket()
    server.adoptAuthenticatedSession(
      ws.asLike(),
      IDENTITY,
      {
        sealer: new EnvelopeSealer(KEY, DIR_S2C),
        // Already AT the frame-count bound: the very next open() throws
        // EnvelopeLimitError before it even looks at the frame's contents.
        opener: new EnvelopeOpener(KEY, DIR_C2S, MAX_ENVELOPE_FRAMES),
      },
      CREDENTIAL_ID
    )

    ws.emit('message', Buffer.alloc(8 + 16), true)

    expect(ws.closedWith).toEqual([[WS_CLOSE_ENVELOPE_USAGE_LIMIT, undefined]])
  })

  it('still closes with the protocol-error code for an ordinary peer violation', () => {
    const ws = new FakeExtensionSocket()
    server.adoptAuthenticatedSession(
      ws.asLike(),
      IDENTITY,
      {
        sealer: new EnvelopeSealer(KEY, DIR_S2C),
        opener: new EnvelopeOpener(KEY, DIR_C2S),
      },
      CREDENTIAL_ID
    )

    // §10: a text frame after channel activation is a protocol violation.
    ws.emit('message', Buffer.from('not an envelope'), false)

    expect(ws.closedWith).toEqual([[WS_CLOSE_PROTOCOL_ERROR, undefined]])
  })

  it('closes with the usage-limit code when an OUTBOUND §10 bound is reached', () => {
    const ws = new FakeExtensionSocket()
    server.adoptAuthenticatedSession(
      ws.asLike(),
      IDENTITY,
      {
        // Already AT the frame-count bound: the very next seal() throws, and no
        // later one can ever succeed, so the connection must be re-established
        // with fresh keys (§8) — the one seal failure that is a connection-level
        // event rather than a single failed write.
        sealer: new EnvelopeSealer(KEY, DIR_S2C, MAX_ENVELOPE_FRAMES),
        opener: new EnvelopeOpener(KEY, DIR_C2S),
      },
      CREDENTIAL_ID
    )
    const session = server.getSession(`chromium:${EXTENSION_ID}`)
    if (!session) throw new Error('session was not registered')

    expect(() => session.envelope.send('{"jsonrpc":"2.0"}')).toThrow(
      EnvelopeLimitError
    )

    expect(ws.closedWith).toEqual([[WS_CLOSE_ENVELOPE_USAGE_LIMIT, undefined]])
  })

  it('closes with the internal-error code when an outbound frame exceeds the 1 MiB cap', () => {
    // Outbound oversize is this process violating §10, not the peer violating
    // it. The refused application frame can desynchronize request state, so
    // the session fails closed with 1011 rather than staying half-usable.
    const ws = new FakeExtensionSocket()
    server.adoptAuthenticatedSession(
      ws.asLike(),
      IDENTITY,
      {
        sealer: new EnvelopeSealer(KEY, DIR_S2C),
        opener: new EnvelopeOpener(KEY, DIR_C2S),
      },
      CREDENTIAL_ID
    )
    const session = server.getSession(`chromium:${EXTENSION_ID}`)
    if (!session) throw new Error('session was not registered')

    expect(() =>
      session.envelope.send(new Uint8Array(1024 * 1024 + 1))
    ).toThrow(EnvelopeViolationError)

    expect(ws.closedWith).toEqual([[WS_CLOSE_INTERNAL_ERROR, undefined]])
    expect(ws.readyState).toBe(3)
    expect(ws.sent).toHaveLength(0)
  })

  it('publishes the exact authenticating credential in the adoption tick', () => {
    const ws = new FakeExtensionSocket()

    server.adoptAuthenticatedSession(
      ws.asLike(),
      IDENTITY,
      {
        sealer: new EnvelopeSealer(KEY, DIR_S2C),
        opener: new EnvelopeOpener(KEY, DIR_C2S),
      },
      CREDENTIAL_ID
    )

    expect(authenticated).toEqual([
      { identity: IDENTITY, credentialId: CREDENTIAL_ID },
    ])
  })
})
