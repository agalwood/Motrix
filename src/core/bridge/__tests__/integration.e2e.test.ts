import { WebSocketBridgeServer } from '@core/bridge/web-socket-bridge-server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type Mbp1TestWiring,
  makeFakeRegistry,
  makeMbp1TestWiring,
  makeStatefulFakePairing,
} from './fakes'
import {
  type IssuedCredential,
  initializeParams,
  mdxpOverChannel,
  pairAndExchange,
  reconnect,
} from './mbp1-client'

const EXTENSION_ID = 'e2eextensionidaaaaaaaaaaaaaaaaaa'
const ORIGIN = `chrome-extension://${EXTENSION_ID}`

describe('integration: ext ↔ Motrix end-to-end (MDXP spec appendix B.2)', () => {
  let server: WebSocketBridgeServer
  let mbp1: Mbp1TestWiring
  let port: number

  beforeEach(async () => {
    mbp1 = await makeMbp1TestWiring([['chromium', EXTENSION_ID]])
    server = new WebSocketBridgeServer({
      pairing: makeStatefulFakePairing(),
      registry: makeFakeRegistry(),
      motrixVersion: '2.0',
      runtime: 'electron',
      ffmpegAvailable: true,
      localToken: 'test-token',
      ...mbp1.options,
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

  /** Step 1 of every flow below: a complete §6 first pair, then drop the
   *  socket, leaving only the stored credential — the extension's cold start. */
  async function pairAndForget(): Promise<IssuedCredential> {
    const paired = await pairAndExchange({
      port,
      origin: ORIGIN,
      browser: 'chromium',
      claimedExtensionId: EXTENSION_ID,
      code: () => mbp1.dialogs.latestCode(),
    })
    paired.wire.ws.close()
    await paired.wire.closed
    return paired.credential
  }

  it('full flow: pair → reconnect /v1 → submit → progress notifications', async () => {
    const credential = await pairAndForget()

    // --- 2. reconnect via /v1 with the stored credential (§8). No token:
    // the challenge–response IS the authentication, and it happens below MDXP.
    const back = await reconnect({
      port,
      origin: ORIGIN,
      instanceId: mbp1.options.instanceId,
      credential,
    })
    const conn = mdxpOverChannel(back.wire, back.channel)

    // ext registers notification handlers before driving anything.
    const progress: unknown[] = []
    let completed: unknown = null
    conn.onNotification('$/task/progress', (p) => {
      progress.push(p)
    })
    conn.onNotification('$/task/completed', (p) => {
      completed = p
    })

    // ext re-initializes on the reconnect — a capabilities exchange now, with
    // no token in the result.
    const initResult = await conn.sendRequest(
      'motrix/initialize',
      initializeParams(EXTENSION_ID)
    )
    expect(initResult.pairToken).toBeUndefined()

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

    // --- 4. server pushes $/task/progress + $/task/completed, sealed by the
    // session's own envelope and opened by the client's.
    const session = server.getSession(`chromium:${EXTENSION_ID}`)
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
    back.wire.ws.close()
  })

  it('cancel flow: download/cancel response is { ok: true }', async () => {
    const credential = await pairAndForget()

    const back = await reconnect({
      port,
      origin: ORIGIN,
      instanceId: mbp1.options.instanceId,
      credential,
    })
    const conn = mdxpOverChannel(back.wire, back.channel)
    await conn.sendRequest('motrix/initialize', initializeParams(EXTENSION_ID))

    const cancelResult = await conn.sendRequest('download/cancel', {
      taskId: 'task-1',
    })
    expect(cancelResult).toMatchObject({ ok: true })

    conn.dispose()
    back.wire.ws.close()
  })
})
