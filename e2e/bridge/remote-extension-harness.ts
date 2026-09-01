import { request as httpRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect as connectTcp } from 'node:net'
import type { BridgeEventBus } from '@core/bridge/bridge-event-bus'
import type { ReadHandlerDeps } from '@core/bridge/handlers/read-handlers'
import type { WriteHandlerDeps } from '@core/bridge/handlers/write-handlers'
import type { DownloadSubmitParams } from '@motrix/mdxp'
import { makeSessionKey } from '@shared/protocol/bridge'
import { EngineState } from '@shared/types/engine'
import {
  bootstrapBridgeForServer,
  type ServerBridgeRuntime,
  type ServerExtensionReceiver,
} from '../../src/server/bridge/bootstrap'
import { parseRemoteExtensionConfig } from '../../src/server/bridge/remote-extension-config'

export const PUBLIC_HOST = 'motrix.test'
export const ROUTE_PREFIX = '/bridge'

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
    pauseTask: async () => {},
    resumeTask: async () => {},
    removeTask: async () => {},
    createTask: async () => ({ taskId: 'unused' }),
    parseTorrentFileCount: async () => 0,
  }
}

function createReceiver(
  submissions: DownloadSubmitParams[],
  bridgeBus: BridgeEventBus
): ServerExtensionReceiver {
  const progressTimers = new Set<ReturnType<typeof setTimeout>>()
  let stopped = false
  return {
    handle: async (params, context) => {
      submissions.push(structuredClone(params))
      const taskId = `browser-task-${submissions.length}`
      const identity = context.identity
      if (identity.kind !== 'extension') {
        throw new Error('remote Extension receiver got a non-Extension session')
      }
      const progressTimer = setTimeout(() => {
        progressTimers.delete(progressTimer)
        if (stopped) return
        bridgeBus.emitTaskProgress({
          sessionKey: makeSessionKey(identity.browser, identity.extensionId),
          params: {
            taskId,
            bytesDone: 512,
            bytesTotal: 1_024,
            speedBps: 256,
            etaSec: 2,
            phase: 'downloading',
          },
        })
      }, 25)
      progressTimers.add(progressTimer)
      progressTimer.unref()
      return { taskId }
    },
    cancel: async () => {},
    restoreInflight: async () => {},
    start: () => {
      stopped = false
    },
    stopAndDrain: async () => {
      stopped = true
      for (const timer of progressTimers) clearTimeout(timer)
      progressTimers.clear()
    },
  }
}

export async function startRuntime(input: {
  dataDir: string
  bridgePort: number
  proxyPort: number
  submissions: DownloadSubmitParams[]
  publicHost?: string
  routePrefix?: string
}): Promise<ServerBridgeRuntime> {
  const publicHost = input.publicHost ?? PUBLIC_HOST
  const routePrefix = input.routePrefix ?? ROUTE_PREFIX
  return bootstrapBridgeForServer({
    userDataDir: input.dataDir,
    host: '127.0.0.1',
    port: input.bridgePort,
    motrixVersion: '2.0.0-beta.remote-e2e',
    eventBus: { on: () => {}, off: () => {}, emit: () => {} },
    readHandlerDeps: readDeps(),
    writeHandlerDeps: writeDeps(),
    remoteExtensionConfig: parseRemoteExtensionConfig({
      MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
      MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: `wss://${publicHost}:${input.proxyPort}${routePrefix}`,
      MOTRIX_PUBLIC_URL: `https://${publicHost}:${input.proxyPort}`,
    }),
    createExtensionReceiver: ({ bridgeBus }) =>
      createReceiver(input.submissions, bridgeBus),
  })
}

export async function startTlsProxy(input: {
  listenPort: number
  upstreamPort: number
  key: string
  cert: string
}): Promise<() => Promise<void>> {
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
    proxy.listen(input.listenPort, '127.0.0.1', () => resolve())
  })
  return () =>
    new Promise<void>((resolve, reject) => {
      proxy.close((error) => (error ? reject(error) : resolve()))
    })
}

export async function pendingPairingCode(
  runtime: ServerBridgeRuntime
): Promise<string | null> {
  const pending = (await runtime.bridgeQueryHandlers[
    'bridge:listPendingPairRequests'
  ]()) as Array<{ kind: string; code?: string }>
  return pending.find((request) => request.kind === 'extension')?.code ?? null
}
