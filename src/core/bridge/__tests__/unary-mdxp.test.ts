import { request as httpRequest } from 'node:http'
import type { PairedClient } from '@core/bridge/pairing-service'
import { WebSocketBridgeServer } from '@core/bridge/web-socket-bridge-server'
import { ErrorCodes } from '@motrix/mdxp'
import { AppError, ErrorCode } from '@shared/errors'
import { EngineState } from '@shared/types/engine'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeFakePairing, makeFakeRegistry } from './fakes'

const LOCAL_TOKEN = 'unit-local-token'

interface RpcResponse {
  status: number
  body: {
    jsonrpc?: string
    id?: unknown
    result?: unknown
    error?: { code: number; message: string; data?: unknown }
  }
}

/** Minimal JSON-RPC-over-HTTP POST using node:http (env-independent). */
function postMdxp(
  port: number,
  payload: unknown,
  opts: { token?: string | null; rawBody?: string } = {}
): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const data = opts.rawBody ?? JSON.stringify(payload)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(data).toString(),
    }
    if (opts.token != null) headers.authorization = `Bearer ${opts.token}`
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/mdxp', method: 'POST', headers },
      (res) => {
        let chunks = ''
        res.on('data', (c) => {
          chunks += c
        })
        res.on('end', () => {
          let body = {}
          try {
            body = chunks ? JSON.parse(chunks) : {}
          } catch {
            body = { _raw: chunks }
          }
          resolve({ status: res.statusCode ?? 0, body })
        })
      }
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

describe('unary POST /mdxp', () => {
  let server: WebSocketBridgeServer
  let port: number

  beforeEach(async () => {
    server = new WebSocketBridgeServer({
      pairing: makeFakePairing(),
      registry: makeFakeRegistry(),
      motrixVersion: '2.0',
      runtime: 'electron',
      ffmpegAvailable: true,
      localToken: LOCAL_TOKEN,
    })
    // submit handler exists so the "non-agent-facing rejected" case is real.
    server.setHandlers({
      submitDownload: async () => ({ taskId: 'task-x' }),
      cancelDownload: async () => undefined,
    })
    server.registerReadMethods({
      taskManager: {
        getAll: () => [
          makeDownloadTask({ id: 'a', status: TaskStatus.Downloading }),
          makeDownloadTask({ id: 'b', status: TaskStatus.Completed }),
        ],
        getById: (id) =>
          id === 'a'
            ? makeDownloadTask({ id: 'a', status: TaskStatus.Downloading })
            : undefined,
      },
      statsAggregator: {
        getStats: () => ({
          totalDownloadSpeed: 1,
          totalUploadSpeed: 2,
          activeTasks: 3,
          waitingTasks: 4,
          stoppedTasks: 5,
        }),
      },
      supervisor: {
        getState: () => EngineState.Ready,
        getFeatureReport: () => null,
      },
    })
    server.registerWriteMethods({
      taskManager: {
        getById: (id) =>
          id === 'created-1' || id === 'reveal-1'
            ? makeDownloadTask({ id, status: TaskStatus.Queued })
            : undefined,
      },
      pauseTask: async () => {},
      resumeTask: async () => {},
      removeTask: async () => {},
      createTask: async () => ({ taskId: 'created-1' }),
      parseTorrentFileCount: async () => 1,
      revealTask: async () => {},
    })
    port = await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('dispatches task/list with a valid token', async () => {
    const res = await postMdxp(
      port,
      { jsonrpc: '2.0', id: 1, method: 'task/list', params: {} },
      { token: LOCAL_TOKEN }
    )
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(1)
    const result = res.body.result as { tasks: unknown[]; total: number }
    expect(result.total).toBe(2)
    expect(result.tasks).toHaveLength(2)
  })

  it('dispatches the agent-facing write method download/add', async () => {
    const res = await postMdxp(
      port,
      {
        jsonrpc: '2.0',
        id: 'w1',
        method: 'download/add',
        params: { kind: 'url', saveDir: '/dl', uris: ['https://x/f.iso'] },
      },
      { token: LOCAL_TOKEN }
    )
    expect(res.status).toBe(200)
    expect((res.body.result as { id: string }).id).toBe('created-1')
  })

  it('maps a not-found (ResourceUnavailable) to HTTP 404, not 500', async () => {
    const res = await postMdxp(
      port,
      {
        jsonrpc: '2.0',
        id: 'w2',
        method: 'task/pause',
        params: { taskId: 'nope' },
      },
      { token: LOCAL_TOKEN }
    )
    expect(res.status).toBe(404)
    expect(res.body.error?.code).toBe(ErrorCodes.ResourceUnavailable)
  })

  it('dispatches stats/get with a valid token', async () => {
    const res = await postMdxp(
      port,
      { jsonrpc: '2.0', id: 2, method: 'stats/get', params: {} },
      { token: LOCAL_TOKEN }
    )
    expect(res.status).toBe(200)
    expect(res.body.result).toMatchObject({ activeTasks: 3, stoppedTasks: 5 })
  })

  it('rejects a missing token with HTTP 401', async () => {
    const res = await postMdxp(port, {
      jsonrpc: '2.0',
      id: 3,
      method: 'task/list',
      params: {},
    })
    expect(res.status).toBe(401)
    expect(res.body.error?.code).toBe(ErrorCodes.PermissionDenied)
  })

  it('rejects a wrong token with HTTP 401', async () => {
    const res = await postMdxp(
      port,
      { jsonrpc: '2.0', id: 4, method: 'task/list', params: {} },
      { token: 'not-the-token' }
    )
    expect(res.status).toBe(401)
  })

  it('rejects a non-agent-facing method (download/submit) with 404 CapabilityNotSupported', async () => {
    const res = await postMdxp(
      port,
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'download/submit',
        params: {},
      },
      { token: LOCAL_TOKEN }
    )
    expect(res.status).toBe(404)
    expect(res.body.error?.code).toBe(ErrorCodes.CapabilityNotSupported)
  })

  it('rejects paired-UI-only task/reveal on the unary agent surface', async () => {
    const res = await postMdxp(
      port,
      {
        jsonrpc: '2.0',
        id: 'reveal',
        method: 'task/reveal',
        params: { taskId: 'reveal-1' },
      },
      { token: LOCAL_TOKEN }
    )
    expect(res.status).toBe(404)
    expect(res.body.error?.code).toBe(ErrorCodes.CapabilityNotSupported)
  })

  it('rejects an unknown method with 404 CapabilityNotSupported', async () => {
    const res = await postMdxp(
      port,
      { jsonrpc: '2.0', id: 6, method: 'totally/madeup', params: {} },
      { token: LOCAL_TOKEN }
    )
    expect(res.status).toBe(404)
    expect(res.body.error?.code).toBe(ErrorCodes.CapabilityNotSupported)
  })

  it('rejects invalid params with 400 InvalidParams', async () => {
    const res = await postMdxp(
      port,
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'task/list',
        params: { limit: -1 },
      },
      { token: LOCAL_TOKEN }
    )
    expect(res.status).toBe(400)
    expect(res.body.error?.code).toBe(ErrorCodes.InvalidParams)
  })

  it('rejects malformed JSON with 400 ParseError', async () => {
    const res = await postMdxp(port, null, {
      token: LOCAL_TOKEN,
      rawBody: '{not json',
    })
    expect(res.status).toBe(400)
    expect(res.body.error?.code).toBe(ErrorCodes.ParseError)
  })

  it('preserves the request id in the response', async () => {
    const res = await postMdxp(
      port,
      { jsonrpc: '2.0', id: 'abc-123', method: 'engine/status', params: {} },
      { token: LOCAL_TOKEN }
    )
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('abc-123')
    expect(res.body.result).toMatchObject({ state: 'ready' })
  })
})

describe('unary POST /mdxp — AppError normalization', () => {
  let server: WebSocketBridgeServer
  let port: number

  beforeEach(async () => {
    server = new WebSocketBridgeServer({
      pairing: makeFakePairing(),
      registry: makeFakeRegistry(),
      motrixVersion: '2.0',
      runtime: 'electron',
      ffmpegAvailable: true,
      localToken: LOCAL_TOKEN,
    })
    server.registerWriteMethods({
      taskManager: { getById: () => undefined },
      pauseTask: async () => {},
      resumeTask: async () => {},
      removeTask: async () => {},
      // handleCreateTask throws AppError (string `code`) on native re-validation;
      // the unary catch must translate it instead of collapsing to a 500.
      createTask: async () => {
        throw new AppError(ErrorCode.IpcInvalidPayload, 'bad native request')
      },
      parseTorrentFileCount: async () => 1,
    })
    port = await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('translates a thrown AppError(IpcInvalidPayload) to 400 InvalidParams (not 500)', async () => {
    const res = await postMdxp(
      port,
      {
        jsonrpc: '2.0',
        id: 'e1',
        method: 'download/add',
        params: { kind: 'url', saveDir: '/dl', uris: ['https://x/f.iso'] },
      },
      { token: LOCAL_TOKEN }
    )
    expect(res.status).toBe(400)
    expect(res.body.error?.code).toBe(ErrorCodes.InvalidParams)
    expect(res.body.error?.message).toContain('bad native request')
  })
})

describe('unary POST /mdxp — paired-token auth (device-code)', () => {
  let server: WebSocketBridgeServer
  let port: number

  const cliClient: PairedClient = {
    identity: { kind: 'cli', id: 'agent-1' },
    token: 'cli-tok',
    name: 'Agent',
    pairedAt: 0,
    lastActiveAt: null,
  }
  const extClient: PairedClient = {
    identity: { kind: 'extension', browser: 'chromium', extensionId: 'ext-1' },
    token: 'ext-tok',
    name: 'Ext',
    pairedAt: 0,
    lastActiveAt: null,
  }

  beforeEach(async () => {
    server = new WebSocketBridgeServer({
      pairing: makeFakePairing({ 'cli-tok': cliClient, 'ext-tok': extClient }),
      registry: makeFakeRegistry(),
      motrixVersion: '2.0',
      runtime: 'electron',
      ffmpegAvailable: true,
      localToken: LOCAL_TOKEN,
    })
    server.registerReadMethods({
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
    })
    port = await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  const list = (token: string) =>
    postMdxp(
      port,
      { jsonrpc: '2.0', id: 1, method: 'task/list', params: {} },
      { token }
    )

  it('accepts a paired cli token', async () => {
    const res = await list('cli-tok')
    expect(res.status).toBe(200)
    expect((res.body.result as { total: number }).total).toBe(0)
  })

  it('rejects an extension token on the unary surface (401)', async () => {
    expect((await list('ext-tok')).status).toBe(401)
  })

  it('rejects an unknown token (401)', async () => {
    expect((await list('nope')).status).toBe(401)
  })

  it('still accepts the machine-owner localToken', async () => {
    expect((await list(LOCAL_TOKEN)).status).toBe(200)
  })
})
