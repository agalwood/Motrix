import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import {
  createServer as createHttpsServer,
  request as httpsRequest,
} from 'node:https'
import { connect as connectTcp } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  exchangeCredential,
  initializeParams,
  mdxpOverChannel,
  runPake,
  startPair,
} from '@core/bridge/__tests__/mbp1-client'
import type { ReadHandlerDeps } from '@core/bridge/handlers/read-handlers'
import type { WriteHandlerDeps } from '@core/bridge/handlers/write-handlers'
import { EngineState } from '@shared/types/engine'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bootstrapBridgeForServer,
  type ServerBridgeRuntime,
  type ServerExtensionReceiver,
} from './bootstrap'
import { parseRemoteExtensionConfig } from './remote-extension-config'

const EXTENSION_ID = 'ibpkjhgpbidfmbmomagmldcdlpbmchgi'

function receiver(): ServerExtensionReceiver {
  return {
    handle: vi.fn(async () => ({ taskId: 'wss-task' })),
    cancel: vi.fn(async () => {}),
    restoreInflight: vi.fn(async () => {}),
    start: vi.fn(),
    stopAndDrain: vi.fn(async () => {}),
  }
}

function readDeps(): ReadHandlerDeps {
  return {
    taskManager: { getAll: () => [], getById: () => undefined },
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

function writeDeps(): WriteHandlerDeps {
  return {
    taskManager: { getById: () => undefined },
    pauseTask: vi.fn(async () => {}),
    resumeTask: vi.fn(async () => {}),
    removeTask: vi.fn(async () => {}),
    createTask: vi.fn(async () => ({ taskId: 'unused' })),
    parseTorrentFileCount: vi.fn(async () => 0),
  }
}

async function startTlsProxy(input: {
  upstreamPort: number
  key: string
  cert: string
}): Promise<{ port: number; close: () => Promise<void> }> {
  const proxy = createHttpsServer({ key: input.key, cert: input.cert })
  proxy.on('request', (request, response) => {
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: input.upstreamPort,
        method: request.method,
        path: request.url,
        headers: request.headers,
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.headers
        )
        upstreamResponse.pipe(response)
      }
    )
    upstream.once('error', () => {
      if (!response.headersSent) response.writeHead(502)
      response.end()
    })
    request.pipe(upstream)
  })
  proxy.on('upgrade', (request, downstream, head) => {
    const upstream = connectTcp(input.upstreamPort, '127.0.0.1')
    upstream.once('connect', () => {
      upstream.write(
        `${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/${request.httpVersion}\r\n`
      )
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        upstream.write(
          `${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}\r\n`
        )
      }
      upstream.write('\r\n')
      if (head.length > 0) upstream.write(head)
      downstream.pipe(upstream).pipe(downstream)
    })
    upstream.once('error', () => downstream.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject)
    proxy.listen(0, '127.0.0.1', () => resolve())
  })
  const address = proxy.address()
  if (address === null || typeof address === 'string') {
    throw new Error('TLS proxy failed to bind')
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        proxy.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

function getDiscovery(input: {
  port: number
  ca?: string
  servername: string
}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: '127.0.0.1',
        port: input.port,
        path: '/bridge/discovery',
        method: 'GET',
        headers: { host: 'motrix.test' },
        servername: input.servername,
        ...(input.ca === undefined ? {} : { ca: input.ca }),
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: body === '' ? null : JSON.parse(body),
          })
        )
      }
    )
    request.once('error', reject)
    request.end()
  })
}

describe('remote Extension through a trusted WSS reverse proxy', () => {
  let userDataDir: string
  let runtime: ServerBridgeRuntime | null = null
  let closeProxy: (() => Promise<void>) | null = null

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'motrix-wss-proxy-'))
  })

  afterEach(async () => {
    if (closeProxy !== null) await closeProxy()
    if (runtime !== null) await runtime.shutdown()
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('rejects an expired certificate even when that certificate is explicitly trusted', async () => {
    const fixtureRoot = join(process.cwd(), 'src/server/bridge/__fixtures__')
    const [cert, key] = await Promise.all([
      readFile(join(fixtureRoot, 'expired-motrix.test-cert.pem'), 'utf8'),
      readFile(join(fixtureRoot, 'expired-motrix.test-key.pem'), 'utf8'),
    ])
    const proxy = await startTlsProxy({ upstreamPort: 1, key, cert })
    closeProxy = proxy.close

    await expect(
      getDiscovery({
        port: proxy.port,
        ca: cert,
        servername: 'motrix.test',
      })
    ).rejects.toMatchObject({ code: 'CERT_HAS_EXPIRED' })
  })

  it('validates TLS hostname/CA, preserves Host/base path, pairs, and submits over WSS', async () => {
    const fixtureRoot = join(process.cwd(), 'src/server/bridge/__fixtures__')
    const [ca, cert, key] = await Promise.all([
      readFile(join(fixtureRoot, 'test-ca.pem'), 'utf8'),
      readFile(join(fixtureRoot, 'motrix.test-cert.pem'), 'utf8'),
      readFile(join(fixtureRoot, 'motrix.test-key.pem'), 'utf8'),
    ])
    const extensionReceiver = receiver()
    runtime = await bootstrapBridgeForServer({
      userDataDir,
      host: '127.0.0.1',
      port: 0,
      motrixVersion: '2.0',
      eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
      readHandlerDeps: readDeps(),
      writeHandlerDeps: writeDeps(),
      remoteExtensionConfig: parseRemoteExtensionConfig({
        MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
        MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: 'wss://motrix.test/bridge',
        MOTRIX_PUBLIC_URL: 'https://motrix.test',
      }),
      createExtensionReceiver: () => extensionReceiver,
    })
    const proxy = await startTlsProxy({
      upstreamPort: runtime.port,
      key,
      cert,
    })
    closeProxy = proxy.close

    await expect(
      getDiscovery({ port: proxy.port, servername: 'motrix.test' })
    ).rejects.toBeDefined()
    await expect(
      getDiscovery({ port: proxy.port, ca, servername: 'wrong.test' })
    ).rejects.toBeDefined()
    await expect(
      getDiscovery({ port: proxy.port, ca, servername: 'motrix.test' })
    ).resolves.toMatchObject({
      status: 200,
      body: { runtime: 'server', extensionPairing: { protocol: 'mbp1' } },
    })

    const secureTransport = { ca, servername: 'motrix.test' }
    const handshake = await startPair({
      port: proxy.port,
      origin: `chrome-extension://${EXTENSION_ID}`,
      browser: 'chromium',
      claimedExtensionId: EXTENSION_ID,
      routePrefix: '/bridge',
      hostHeader: 'motrix.test',
      secureTransport,
    })
    const pending = (await runtime.bridgeQueryHandlers[
      'bridge:listPendingPairRequests'
    ]()) as Array<{ code?: string }>
    const code = pending[0]?.code
    if (code === undefined) throw new Error('pairing code missing')
    const { channel } = await runPake(handshake, code)
    await exchangeCredential(handshake, channel)
    const connection = mdxpOverChannel(handshake.wire, channel)
    await connection.sendRequest(
      'motrix/initialize',
      initializeParams(EXTENSION_ID)
    )
    await expect(
      connection.sendRequest('download/submit', {
        source: {
          pageUrl: 'https://example.com/watch',
          pageTitle: 'WSS',
          detectedAt: 1,
        },
        selection: {
          kind: 'direct',
          primary: {
            url: 'https://cdn.example.com/video.mp4',
            headers: {},
            cookies: [],
            refererPolicy: 'strict-origin-when-cross-origin',
          },
        },
        meta: { suggestedFilename: 'video.mp4', qualityLabel: 'source' },
      })
    ).resolves.toEqual({ taskId: 'wss-task' })
    expect(extensionReceiver.handle).toHaveBeenCalledOnce()
    connection.dispose()
    handshake.wire.ws.close()
    await handshake.wire.closed
  })
})
