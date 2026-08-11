import { WebSocketBridgeServer } from '@core/bridge/web-socket-bridge-server'
import {
  WebSocketMessageReader,
  WebSocketMessageWriter,
} from '@core/bridge/web-socket-message-stream'
import { createMdxpConnection } from '@motrix/mdxp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { makeFakeRegistry, makeStatefulFakePairing } from './fakes'

describe('integration: ext ↔ Motrix end-to-end (MDXP spec appendix B.2)', () => {
  let server: WebSocketBridgeServer
  let port: number

  beforeEach(async () => {
    server = new WebSocketBridgeServer({
      pairing: makeStatefulFakePairing(),
      registry: makeFakeRegistry(),
      onPairRequest: async () => ({ decision: 'allow', addToRegistry: false }),
      motrixVersion: '2.0',
      runtime: 'electron',
      ffmpegAvailable: true,
      localToken: 'test-token',
    })
    server.setHandlers({
      submitDownload: async () => ({ taskId: 'task-1' }),
      cancelDownload: async () => undefined,
    })
    port = await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('full flow: pair → reconnect /v1 → submit → progress notifications', async () => {
    // --- 1. pair via /pair to get a token
    const nonce = server.issuePairNonce()
    const pairWs = new WebSocket(
      `ws://127.0.0.1:${port}/pair?nonce=${nonce}&extensionId=abc&browser=chromium&extensionName=test&extensionVersion=0.1`,
      'motrix-bridge.v1',
      { origin: 'chrome-extension://abc' }
    )
    await new Promise<void>((resolve, reject) => {
      pairWs.once('open', () => resolve())
      pairWs.once('error', reject)
    })
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
    expect(initResult.pairToken).toBeDefined()
    const token = initResult.pairToken!
    pairConn.dispose()
    pairWs.close()

    // --- 2. reconnect via /v1 using the token
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/v1?token=${token}`,
      'motrix-bridge.v1',
      { origin: 'chrome-extension://abc' }
    )
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    const conn = createMdxpConnection(
      new WebSocketMessageReader(ws as never),
      new WebSocketMessageWriter(ws as never)
    )

    // ext registers notification handlers BEFORE listen()
    const progress: unknown[] = []
    let completed: unknown = null
    conn.onNotification('$/task/progress', (p) => {
      progress.push(p)
    })
    conn.onNotification('$/task/completed', (p) => {
      completed = p
    })

    conn.listen()

    // ext re-initializes on the reconnect (per spec §5)
    await conn.sendRequest('motrix/initialize', {
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

    // ext announces it's ready
    conn.sendNotification('motrix/initialized', undefined)

    // --- 3. ext submits a download
    const submitResult = await conn.sendRequest('download/submit', {
      source: {
        pageUrl: 'https://example.com/v',
        pageTitle: 'demo',
        detectedAt: Date.now(),
      },
      selection: {
        kind: 'direct',
        primary: {
          url: 'https://cdn.example.com/v.mp4',
          headers: {},
          cookies: [],
          refererPolicy: 'strict-origin-when-cross-origin',
        },
      },
      meta: { suggestedFilename: 'v.mp4', qualityLabel: '720p' },
    })
    expect(submitResult.taskId).toBe('task-1')

    // --- 4. server pushes $/task/progress + $/task/completed
    const session = server.getSession('chromium:abc')
    if (!session) throw new Error('session not found after submit')
    session.conn.sendNotification('$/task/progress', {
      taskId: 'task-1',
      bytesDone: 500,
      bytesTotal: 1000,
      speedBps: 100,
      etaSec: 5,
      phase: 'downloading',
    })
    session.conn.sendNotification('$/task/completed', {
      taskId: 'task-1',
      filePath: '/tmp/v.mp4',
      durationMs: 5000,
    })

    // give the event loop a few ticks for the ext-side handlers to fire
    await new Promise((r) => setTimeout(r, 50))

    expect(progress).toHaveLength(1)
    expect(progress[0]).toMatchObject({
      taskId: 'task-1',
      phase: 'downloading',
    })
    expect(completed).toMatchObject({
      taskId: 'task-1',
      filePath: '/tmp/v.mp4',
      durationMs: 5000,
    })

    conn.dispose()
    ws.close()
  })

  it('cancel flow: download/cancel response is { ok: true }', async () => {
    // Pair + reconnect (abbreviated)
    const nonce = server.issuePairNonce()
    const pairWs = new WebSocket(
      `ws://127.0.0.1:${port}/pair?nonce=${nonce}&extensionId=abc&browser=chromium`,
      'motrix-bridge.v1',
      { origin: 'chrome-extension://abc' }
    )
    await new Promise<void>((r) => pairWs.once('open', r))
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

    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/v1?token=${ir.pairToken}`,
      'motrix-bridge.v1',
      { origin: 'chrome-extension://abc' }
    )
    await new Promise<void>((r) => ws.once('open', r))
    const conn = createMdxpConnection(
      new WebSocketMessageReader(ws as never),
      new WebSocketMessageWriter(ws as never)
    )
    conn.listen()
    await conn.sendRequest('motrix/initialize', {
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

    const cancelResult = await conn.sendRequest('download/cancel', {
      taskId: 'task-1',
    })
    expect(cancelResult).toMatchObject({ ok: true })

    conn.dispose()
    ws.close()
  })
})
