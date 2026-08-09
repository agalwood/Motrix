import type { Browser } from '@core/bridge/bridge-connection'
import type { ReadHandlerDeps } from '@core/bridge/handlers/read-handlers'
import type { WriteHandlerDeps } from '@core/bridge/handlers/write-handlers'
import type { TrustedExtensionRegistry } from '@core/bridge/trusted-extension-registry'
import { WebSocketBridgeServer } from '@core/bridge/web-socket-bridge-server'
import {
  WebSocketMessageReader,
  WebSocketMessageWriter,
} from '@core/bridge/web-socket-message-stream'
import { createMdxpConnection } from '@motrix/mdxp'
import { EngineState } from '@shared/types/engine'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { makeStatefulFakePairing } from './fakes'

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

describe('WebSocketBridgeServer (JSON-RPC)', () => {
  let server: WebSocketBridgeServer
  let port: number

  beforeEach(async () => {
    server = new WebSocketBridgeServer({
      pairing: makeStatefulFakePairing(),
      registry: makeFakeRegistry(),
      onPairRequest: async () => ({ decision: 'allow', addToRegistry: false }),
      motrixVersion: '2.0',
      ffmpegAvailable: true,
      localToken: 'test-token',
    })
    port = await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('/pair flow returns pairToken via motrix/initialize', async () => {
    const nonce = server.issuePairNonce()
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/pair?nonce=${nonce}&extensionId=abc&browser=chromium&extensionName=test&extensionVersion=0.1`,
      'motrix-bridge.v1',
      { origin: 'chrome-extension://abc' }
    )
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })

    const reader = new WebSocketMessageReader(ws as never)
    const writer = new WebSocketMessageWriter(ws as never)
    const conn = createMdxpConnection(reader, writer)
    conn.listen()

    const result = await conn.sendRequest('motrix/initialize', {
      protocolVersion: '1.0',
      client: {
        kind: 'extension',
        name: 'motrix-extension',
        version: '0.1',
        extensionId: 'abc',
        browser: 'chromium',
        browserVersion: '120',
        locale: 'en',
      },
      capabilities: { submitDownload: true },
      adapters: [],
    })

    expect(result.protocolVersion).toBe('1.0')
    expect(result.server.name).toBe('motrix')
    expect(result.pairToken).toMatch(/^tok-/)

    conn.dispose()
    ws.close()
  })

  it('/v1 with valid token succeeds', async () => {
    // First pair to get a token.
    const nonce = server.issuePairNonce()
    const pairWs = new WebSocket(
      `ws://127.0.0.1:${port}/pair?nonce=${nonce}&extensionId=abc&browser=chromium`,
      'motrix-bridge.v1',
      { origin: 'chrome-extension://abc' }
    )
    await new Promise<void>((resolve) => pairWs.once('open', resolve))
    const pairConn = createMdxpConnection(
      new WebSocketMessageReader(pairWs as never),
      new WebSocketMessageWriter(pairWs as never)
    )
    pairConn.listen()
    const initResult = await pairConn.sendRequest('motrix/initialize', {
      protocolVersion: '1.0',
      client: {
        kind: 'extension',
        name: 'motrix-extension',
        version: '0.1',
        extensionId: 'abc',
        browser: 'chromium',
        browserVersion: '120',
        locale: 'en',
      },
      capabilities: {},
      adapters: [],
    })
    const token = initResult.pairToken
    expect(token).toBeDefined()
    pairConn.dispose()
    pairWs.close()

    // Now reconnect via /v1 with the token.
    const v1Ws = new WebSocket(
      `ws://127.0.0.1:${port}/v1?token=${token}`,
      'motrix-bridge.v1',
      { origin: 'chrome-extension://abc' }
    )
    await new Promise<void>((resolve, reject) => {
      v1Ws.once('open', () => resolve())
      v1Ws.once('error', reject)
    })
    const v1Conn = createMdxpConnection(
      new WebSocketMessageReader(v1Ws as never),
      new WebSocketMessageWriter(v1Ws as never)
    )
    v1Conn.listen()
    const reconnectResult = await v1Conn.sendRequest('motrix/initialize', {
      protocolVersion: '1.0',
      client: {
        kind: 'extension',
        name: 'motrix-extension',
        version: '0.1',
        extensionId: 'abc',
        browser: 'chromium',
        browserVersion: '120',
        locale: 'en',
      },
      capabilities: {},
      adapters: [],
    })
    expect(reconnectResult.protocolVersion).toBe('1.0')
    v1Conn.dispose()
    v1Ws.close()
  })

  it('/v1 with invalid token closes with 401', async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/v1?token=bogus`,
      'motrix-bridge.v1',
      { origin: 'chrome-extension://abc' }
    )
    await expect(
      new Promise<void>((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
    ).rejects.toThrow()
  })

  it('rejects upgrade without motrix-bridge.v1 subprotocol', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1?token=x`, {
      origin: 'chrome-extension://abc',
    })
    await expect(
      new Promise<void>((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
    ).rejects.toThrow()
  })

  it('system/ping round-trip on /v1 session', async () => {
    // Pair first
    const nonce = server.issuePairNonce()
    const pairWs = new WebSocket(
      `ws://127.0.0.1:${port}/pair?nonce=${nonce}&extensionId=abc&browser=chromium`,
      'motrix-bridge.v1',
      { origin: 'chrome-extension://abc' }
    )
    await new Promise<void>((resolve) => pairWs.once('open', resolve))
    const pc = createMdxpConnection(
      new WebSocketMessageReader(pairWs as never),
      new WebSocketMessageWriter(pairWs as never)
    )
    pc.listen()
    const ir = await pc.sendRequest('motrix/initialize', {
      protocolVersion: '1.0',
      client: {
        kind: 'extension',
        name: 'x',
        version: '1',
        extensionId: 'abc',
        browser: 'chromium',
        browserVersion: '1',
        locale: 'en',
      },
      capabilities: {},
      adapters: [],
    })
    pc.dispose()
    pairWs.close()

    // Now /v1
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/v1?token=${ir.pairToken}`,
      'motrix-bridge.v1',
      { origin: 'chrome-extension://abc' }
    )
    await new Promise<void>((resolve) => ws.once('open', resolve))
    const conn = createMdxpConnection(
      new WebSocketMessageReader(ws as never),
      new WebSocketMessageWriter(ws as never)
    )
    conn.listen()

    const before = Date.now()
    const pong = await conn.sendRequest('system/ping', { sentAt: before })
    expect(pong.sentAt).toBe(before)
    expect(pong.recvAt).toBeGreaterThanOrEqual(before)

    conn.dispose()
    ws.close()
  })

  it('GET /nonce returns a fresh nonce JSON', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nonce`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { nonce: string }
    expect(json.nonce).toMatch(/^[A-Za-z0-9_-]{16,}$/)
  })

  it('consumes a pairing nonce exactly once', async () => {
    const nonce = server.issuePairNonce()
    const pairUrl = `ws://127.0.0.1:${port}/pair?nonce=${nonce}&extensionId=abc&browser=chromium`
    const first = new WebSocket(pairUrl, 'motrix-bridge.v1', {
      origin: 'chrome-extension://abc',
    })
    await new Promise<void>((resolve, reject) => {
      first.once('open', resolve)
      first.once('error', reject)
    })

    const replay = new WebSocket(pairUrl, 'motrix-bridge.v1', {
      origin: 'chrome-extension://abc',
    })
    await expect(
      new Promise<void>((resolve, reject) => {
        replay.once('open', resolve)
        replay.once('error', reject)
      })
    ).rejects.toThrow()

    first.close()
  })
})

describe('WebSocketBridgeServer.start() bind guard', () => {
  function makeServer(localToken: string): WebSocketBridgeServer {
    return new WebSocketBridgeServer({
      pairing: makeStatefulFakePairing(),
      registry: makeFakeRegistry(),
      onPairRequest: async () => ({ decision: 'allow', addToRegistry: false }),
      motrixVersion: '2.0',
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

function makeFakeWriteDeps(): WriteHandlerDeps {
  return {
    taskManager: { getById: () => undefined },
    pauseTask: async () => {},
    resumeTask: async () => {},
    removeTask: async () => {},
    createTask: async () => ({ taskId: 'new-task' }),
    parseTorrentFileCount: async () => 0,
  }
}

/** Pair an extension via /pair + motrix/initialize and return the pairToken. */
async function pairExtension(port: number): Promise<{ token: string }> {
  const nonce = (await (
    await fetch(`http://127.0.0.1:${port}/nonce`)
  ).json()) as { nonce: string }
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/pair?nonce=${nonce.nonce}&extensionId=abc&browser=chromium`,
    'motrix-bridge.v1',
    { origin: 'chrome-extension://abc' }
  )
  await new Promise<void>((resolve) => ws.once('open', resolve))
  const conn = createMdxpConnection(
    new WebSocketMessageReader(ws as never),
    new WebSocketMessageWriter(ws as never)
  )
  conn.listen()
  const result = await conn.sendRequest('motrix/initialize', {
    protocolVersion: '1.0',
    client: {
      kind: 'extension',
      name: 'motrix-extension',
      version: '0.1',
      extensionId: 'abc',
      browser: 'chromium',
      browserVersion: '120',
      locale: 'en',
    },
    capabilities: { submitDownload: true },
    adapters: [],
  })
  conn.dispose()
  ws.close()
  return { token: result.pairToken as string }
}

/** Open a /v1 WebSocket with the given token, send motrix/initialized, return the connection. */
async function openV1Session(
  port: number,
  token: string
): Promise<{ conn: ReturnType<typeof createMdxpConnection>; ws: WebSocket }> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/v1?token=${token}`,
    'motrix-bridge.v1',
    { origin: 'chrome-extension://abc' }
  )
  await new Promise<void>((resolve) => ws.once('open', resolve))
  const conn = createMdxpConnection(
    new WebSocketMessageReader(ws as never),
    new WebSocketMessageWriter(ws as never)
  )
  conn.listen()
  // Signal ready (mirrors extension behaviour post-initialize on /v1).
  conn.sendNotification('motrix/initialized', undefined as never)
  return { conn, ws }
}

describe('WebSocketBridgeServer – v1 control-plane over WS', () => {
  let server: WebSocketBridgeServer
  let port: number

  beforeEach(async () => {
    server = new WebSocketBridgeServer({
      pairing: makeStatefulFakePairing(),
      registry: {
        load: async () => {},
        has: () => true,
        add: async () => {},
        remove: async () => {},
        listManifestIds: () => [],
      } as unknown as TrustedExtensionRegistry,
      onPairRequest: async () => ({ decision: 'allow', addToRegistry: false }),
      motrixVersion: '2.0',
      ffmpegAvailable: true,
      localToken: 'test-token',
    })
    server.registerReadMethods(makeFakeReadDeps())
    server.registerWriteMethods(makeFakeWriteDeps())
    port = await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('exposes the v1 control-plane over a paired extension WS but not download/add', async () => {
    // Arrange: pair first to get a token, then open /v1.
    const { token } = await pairExtension(port)
    const { conn, ws } = await openV1Session(port, token)

    // task/list reaches the dispatcher and returns its shape.
    const list = await conn.sendRequest('task/list', {})
    expect(list).toEqual({ tasks: [], total: 0 })

    // stats/get reaches the dispatcher.
    const stats = await conn.sendRequest('stats/get', {})
    expect(stats).toHaveProperty('activeTasks')

    // download/add is NOT wired on WS → MethodNotFound (-32601).
    await expect(
      conn.sendRequest('download/add', {
        kind: 'url',
        saveDir: '/tmp',
        uris: ['https://example.com/a.bin'],
      })
    ).rejects.toMatchObject({ code: -32601 })

    conn.dispose()
    ws.close()
  })
})
