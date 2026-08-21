import {
  createServer as createHttpServer,
  request as httpRequest,
} from 'node:http'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { type Mbp1TestWiring, makeMbp1TestWiring } from './__tests__/fakes'
import {
  fetchNonce,
  mdxpOverChannel,
  pairAndExchange,
} from './__tests__/mbp1-client'
import {
  type PairedClient,
  PairingService,
  type PairingStore,
} from './pairing-service'
import { WebSocketBridgeServer } from './web-socket-bridge-server'

const EXTENSION_ID = 'stopextensionidaaaaaaaaaaaaaaaaa'
const ORIGIN = `chrome-extension://${EXTENSION_ID}`

function makePairingStore(): PairingStore {
  let list: PairedClient[] = []
  return {
    async load() {
      return [...list]
    },
    async save(next) {
      list = [...next]
    },
  }
}

function makeRegistryStore() {
  let data: string | null = null
  return {
    async read() {
      return data
    },
    async write(s: string) {
      data = s
    },
  }
}

async function makeServer(
  mbp1: Mbp1TestWiring | null = null
): Promise<WebSocketBridgeServer> {
  const pairing = new PairingService(makePairingStore())
  await pairing.load()
  const { TrustedExtensionRegistry } = await import(
    './trusted-extension-registry'
  )
  const registry = new TrustedExtensionRegistry(makeRegistryStore(), [])
  await registry.load()
  return new WebSocketBridgeServer({
    pairing,
    registry,
    motrixVersion: '0.0.0-test',
    runtime: 'electron',
    ffmpegAvailable: false,
    localToken: 'test-local-token',
    ...(mbp1 === null ? {} : mbp1.options),
  })
}

/**
 * Upgrade `/pair` and stop there, so the socket is live but PRE-authenticated.
 * That is the interesting case for `stop()`: a pre-auth connection is held in
 * `PreAuthTable`, never in `this.sessions`, so the dispose loop does not see it
 * and only the `wss.clients` terminate loop can kill it.
 */
async function connectPreAuth(port: number): Promise<WebSocket> {
  const nonce = await fetchNonce(port)
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/pair?nonce=${nonce}`,
      'motrix-bridge.v1',
      { origin: ORIGIN }
    )
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function deferred(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function postPause(port: number): Promise<void> {
  return new Promise((resolve) => {
    const data = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'task/pause',
      params: { taskId: 'task-1' },
    })
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/mdxp',
        method: 'POST',
        headers: {
          authorization: 'Bearer test-local-token',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
        },
      },
      (res) => {
        res.resume()
        res.once('end', resolve)
      }
    )
    // stop() intentionally tears down transport before draining the accepted
    // handler, so an ECONNRESET is also a completed client observation.
    req.once('error', resolve)
    req.end(data)
  })
}

describe('WebSocketBridgeServer.stop', () => {
  it('resolves promptly even while an extension WebSocket is still open', async () => {
    const server = await makeServer(await makeMbp1TestWiring())
    const port = await server.start('127.0.0.1', 0)
    const ws = await connectPreAuth(port)

    const result = await Promise.race([
      server.stop().then(() => 'stopped' as const),
      new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), 3000)
      ),
    ])

    expect(result).toBe('stopped')
    ws.terminate()
  })

  it('closes ingress immediately but waits for an already-accepted MDXP handler', async () => {
    const server = await makeServer()
    const handlerStarted = deferred()
    const releaseHandler = deferred()
    server.registerWriteMethods({
      taskManager: {
        getById: () =>
          makeDownloadTask({
            id: 'task-1',
            status: TaskStatus.Downloading,
          }),
      },
      pauseTask: vi.fn(async () => {
        handlerStarted.resolve()
        await releaseHandler.promise
      }),
      resumeTask: vi.fn(async () => {}),
      removeTask: vi.fn(async () => {}),
      createTask: vi.fn(async () => ({ taskId: 'unused' })),
      parseTorrentFileCount: vi.fn(async () => 1),
    })
    const port = await server.start('127.0.0.1', 0)
    const request = postPause(port)
    await handlerStarted.promise

    let stopped = false
    const stop = server.stop()
    void stop.then(() => {
      stopped = true
    })
    expect(server.stop()).toBe(stop)
    await Promise.resolve()
    await Promise.resolve()

    expect(stopped).toBe(false)
    releaseHandler.resolve()
    await stop
    await request
  })

  it('drains an accepted WebSocket handler and rejects dispatch admitted after the gate closes', async () => {
    const mbp1 = await makeMbp1TestWiring([['chromium', EXTENSION_ID]])
    const server = await makeServer(mbp1)
    const handlerStarted = deferred()
    const releaseHandler = deferred()
    server.registerWriteMethods({
      taskManager: {
        getById: () =>
          makeDownloadTask({
            id: 'task-1',
            status: TaskStatus.Downloading,
          }),
      },
      pauseTask: vi.fn(async () => {
        handlerStarted.resolve()
        await releaseHandler.promise
      }),
      resumeTask: vi.fn(async () => {}),
      removeTask: vi.fn(async () => {}),
      createTask: vi.fn(async () => ({ taskId: 'unused' })),
      parseTorrentFileCount: vi.fn(async () => 1),
    })
    const port = await server.start('127.0.0.1', 0)
    const paired = await pairAndExchange({
      port,
      origin: ORIGIN,
      browser: 'chromium',
      claimedExtensionId: EXTENSION_ID,
      code: () => mbp1.dialogs.latestCode(),
    })
    const ws = paired.wire.ws
    const conn = mdxpOverChannel(paired.wire, paired.channel)
    conn.sendNotification('motrix/initialized', undefined as never)
    const request = conn.sendRequest('task/pause', { taskId: 'task-1' })
    void request.catch(() => {})
    await handlerStarted.promise

    const stop = server.stop()
    expect(server.stop()).toBe(stop)
    const lateDispatch = (
      server as unknown as {
        dispatchTracked(
          method: string,
          params: unknown,
          context: unknown
        ): Promise<unknown>
      }
    ).dispatchTracked('task/pause', { taskId: 'task-1' }, {})
    await expect(lateDispatch).rejects.toThrow(/stopped/)

    let stopped = false
    void stop.then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)

    releaseHandler.resolve()
    await stop
    conn.dispose()
    ws.terminate()
  })

  it('rolls back cleanly when bind loses a real port race', async () => {
    const blocker = createHttpServer()
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(0, '127.0.0.1', resolve)
    })
    const address = blocker.address()
    if (!address || typeof address === 'string') {
      throw new Error('failed to allocate blocker port')
    }

    const server = await makeServer()
    await expect(server.start('127.0.0.1', address.port)).rejects.toMatchObject(
      {
        code: 'EADDRINUSE',
      }
    )
    const stop = server.stop()
    expect(server.stop()).toBe(stop)
    await expect(stop).resolves.toBeUndefined()
    await new Promise<void>((resolve, reject) =>
      blocker.close((error) => (error ? reject(error) : resolve()))
    )
  })
})
