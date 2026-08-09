import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EndpointFileWriter } from '@core/bridge/endpoint-file-writer'
import type { ReadHandlerDeps } from '@core/bridge/handlers/read-handlers'
import type { WriteHandlerDeps } from '@core/bridge/handlers/write-handlers'
import { PairingService } from '@core/bridge/pairing-service'
import { WebSocketBridgeServer } from '@core/bridge/web-socket-bridge-server'
import { BridgeStreamSource } from '@core/bridge-receiver/bridge-stream-source'
import { EventBus } from '@core/events/event-bus'
import { Events } from '@shared/protocol/events'
import { EngineState } from '@shared/types/engine'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootstrapBridgeForServer } from './bootstrap'

function readDeps(): ReadHandlerDeps {
  return {
    taskManager: {
      getAll: () => [
        makeDownloadTask({ id: 'a', status: TaskStatus.Downloading }),
      ],
      getById: () => undefined,
    },
    statsAggregator: {
      getStats: () => ({
        totalDownloadSpeed: 0,
        totalUploadSpeed: 0,
        activeTasks: 1,
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
    createTask: vi.fn(async () => ({ taskId: 'x' })),
    parseTorrentFileCount: vi.fn(async () => 1),
  }
}

interface Resp {
  status: number
  body: { result?: unknown; error?: { code: number } }
}
function post(port: number, payload: unknown, token?: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(data).toString(),
    }
    if (token) headers.authorization = `Bearer ${token}`
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/mdxp', method: 'POST', headers },
      (res) => {
        let chunks = ''
        res.on('data', (c) => {
          chunks += c
        })
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: chunks ? JSON.parse(chunks) : {},
          })
        )
      }
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

interface SseClient {
  status: number
  waitForFrame: () => Promise<{ event: string; data: unknown }>
  close: () => void
}
function sseConnect(port: number, token: string): Promise<SseClient> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/mdxp/events',
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      (res) => {
        const queue: Array<{ event: string; data: unknown }> = []
        const waiters: Array<(f: { event: string; data: unknown }) => void> = []
        let buf = ''
        res.setEncoding('utf-8')
        res.on('data', (chunk: string) => {
          buf += chunk
          let idx = buf.indexOf('\n\n')
          while (idx !== -1) {
            const raw = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            idx = buf.indexOf('\n\n')
            if (raw.startsWith(':') || raw.trim() === '') continue
            let event = 'message'
            let data: unknown
            for (const line of raw.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim()
              else if (line.startsWith('data:')) {
                try {
                  data = JSON.parse(line.slice(5).trim())
                } catch {
                  data = line.slice(5).trim()
                }
              }
            }
            const f = { event, data }
            const w = waiters.shift()
            if (w) w(f)
            else queue.push(f)
          }
        })
        resolve({
          status: res.statusCode ?? 0,
          waitForFrame: () =>
            new Promise((r) => {
              const q = queue.shift()
              if (q) r(q)
              else waiters.push(r)
            }),
          close: () => req.destroy(),
        })
      }
    )
    req.on('error', () => {})
    req.end()
  })
}

describe('bootstrapBridgeForServer', () => {
  let userDataDir: string
  let runtime: Awaited<ReturnType<typeof bootstrapBridgeForServer>> | null =
    null

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'motrix-server-bridge-'))
  })
  afterEach(async () => {
    if (runtime) await runtime.shutdown()
    runtime = null
    vi.restoreAllMocks()
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('serves task/list over POST /mdxp with the minted localToken', async () => {
    runtime = await bootstrapBridgeForServer({
      userDataDir,
      host: '127.0.0.1',
      port: 0,
      motrixVersion: '2.0',
      eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
      readHandlerDeps: readDeps(),
      writeHandlerDeps: writeDeps(),
    })
    expect(runtime.port).toBeGreaterThan(0)
    expect(runtime.localToken).toMatch(/\S{16,}/)
    const res = await post(
      runtime.port,
      { jsonrpc: '2.0', id: 1, method: 'task/list', params: {} },
      runtime.localToken
    )
    expect(res.status).toBe(200)
    expect((res.body.result as { total: number }).total).toBe(1)
  })

  it('rejects a missing token with 401', async () => {
    runtime = await bootstrapBridgeForServer({
      userDataDir,
      host: '127.0.0.1',
      port: 0,
      motrixVersion: '2.0',
      eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
      readHandlerDeps: readDeps(),
      writeHandlerDeps: writeDeps(),
    })
    const res = await post(runtime.port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'task/list',
      params: {},
    })
    expect(res.status).toBe(401)
  })

  it('device-code: request emits a web prompt, approve issues a token, listPaired shows the cli', async () => {
    const emit = vi.fn()
    runtime = await bootstrapBridgeForServer({
      userDataDir,
      host: '127.0.0.1',
      port: 0,
      motrixVersion: '2.0',
      eventBus: { on: vi.fn(), off: vi.fn(), emit },
      readHandlerDeps: readDeps(),
      writeHandlerDeps: writeDeps(),
    })
    const base = `http://127.0.0.1:${runtime.port}`

    // 1. a fresh agent requests a device code (un-authenticated)
    const reqRes = await fetch(`${base}/mdxp/pair/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientName: 'Agent', clientVersion: '1' }),
    })
    expect(reqRes.status).toBe(200)
    const reqBody = (await reqRes.json()) as { requestId: string }

    // the approval prompt is re-emitted onto the core bus → web broadcaster
    expect(emit).toHaveBeenCalledWith(
      'bridge:pairRequested',
      expect.objectContaining({ kind: 'cli', requestId: reqBody.requestId })
    )

    // 2. the web UI approves via the bridge:resolvePair command handler
    await runtime.bridgeCommandHandlers['bridge:resolvePair']({
      kind: 'cli',
      requestId: reqBody.requestId,
      decision: 'allow',
    })

    // 3. the agent's poll now yields the issued token
    const pollRes = await fetch(`${base}/mdxp/pair/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: reqBody.requestId }),
    })
    const pollBody = (await pollRes.json()) as {
      status: string
      token?: string
    }
    expect(pollBody.status).toBe('approved')
    expect(typeof pollBody.token).toBe('string')

    // approval announces a Paired event (→ web paired-client list refresh)
    expect(emit).toHaveBeenCalledWith(
      'bridge:paired',
      expect.objectContaining({
        identity: { kind: 'cli', id: expect.any(String) },
      })
    )

    // 4. THE POINT: the issued token authenticates the agent surface — both the
    // unary POST /mdxp and the SSE firehose — not just the pairing handshake.
    const issuedToken = pollBody.token as string
    const listed = await post(
      runtime.port,
      { jsonrpc: '2.0', id: 1, method: 'task/list', params: {} },
      issuedToken
    )
    expect(listed.status).toBe(200)
    expect((listed.body.result as { total: number }).total).toBe(1)

    const sse = await sseConnect(runtime.port, issuedToken)
    expect(sse.status).toBe(200)
    sse.close()

    // 5. listPaired (web Settings) shows the paired cli — no token leaked
    const paired = (await runtime.bridgeQueryHandlers[
      'bridge:listPaired'
    ]()) as Array<{
      kind: string
      token?: string
    }>
    expect(paired).toHaveLength(1)
    expect(paired[0].kind).toBe('cli')
    expect(paired[0].token).toBeUndefined()
  })

  it('device-code: settle/expire push is re-emitted on the server EventBus', async () => {
    // A short real TTL (rather than fake timers) so the expiry assertion below
    // observes a genuine timer fire over the real HTTP server + fetch() calls
    // in this test — fake timers would also stall the real socket I/O they run on.
    const emit = vi.fn()
    runtime = await bootstrapBridgeForServer({
      userDataDir,
      host: '127.0.0.1',
      port: 0,
      motrixVersion: '2.0',
      eventBus: { on: vi.fn(), off: vi.fn(), emit },
      readHandlerDeps: readDeps(),
      writeHandlerDeps: writeDeps(),
      deviceCodeTtlMs: 30,
    })
    const base = `http://127.0.0.1:${runtime.port}`

    // 1. approve() fires the settled push.
    const reqRes = await fetch(`${base}/mdxp/pair/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientName: 'Agent', clientVersion: '1' }),
    })
    const { requestId } = (await reqRes.json()) as { requestId: string }
    await runtime.bridgeCommandHandlers['bridge:resolvePair']({
      kind: 'cli',
      requestId,
      decision: 'allow',
    })
    expect(emit).toHaveBeenCalledWith(
      'bridge:pairRequestSettled',
      expect.objectContaining({ key: `cli:${requestId}`, outcome: 'allowed' })
    )

    // 2. a second, never-decided request lapses past its (short, test-only) TTL.
    const reqRes2 = await fetch(`${base}/mdxp/pair/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientName: 'Agent2', clientVersion: '1' }),
    })
    const { requestId: requestId2 } = (await reqRes2.json()) as {
      requestId: string
    }
    await vi.waitFor(() => {
      expect(emit).toHaveBeenCalledWith(
        'bridge:pairRequestExpired',
        expect.objectContaining({ key: `cli:${requestId2}` })
      )
    })
  })

  it('writes endpoint.json with the port + localToken and attaches the SSE source', async () => {
    const on = vi.fn()
    runtime = await bootstrapBridgeForServer({
      userDataDir,
      host: '127.0.0.1',
      port: 0,
      motrixVersion: '2.0',
      eventBus: { on, off: vi.fn(), emit: vi.fn() },
      readHandlerDeps: readDeps(),
      writeHandlerDeps: writeDeps(),
    })
    const endpoint = JSON.parse(
      await readFile(join(userDataDir, 'bridge', 'endpoint.json'), 'utf-8')
    )
    expect(endpoint.port).toBe(runtime.port)
    expect(endpoint.localToken).toBe(runtime.localToken)
    // SSE firehose subscribed the core EventBus
    expect(on).toHaveBeenCalledWith('event:taskUpdated', expect.any(Function))
  })

  it('streams $/task/progress over SSE when a REAL EventBus emits TaskUpdated(array)', async () => {
    // Guards the server payload contract: the firehose derives $/task/* from a
    // DownloadTask[] array. A payload-less emit (the bug) would never fire.
    const eventBus = new EventBus()
    runtime = await bootstrapBridgeForServer({
      userDataDir,
      host: '127.0.0.1',
      port: 0,
      motrixVersion: '2.0',
      eventBus,
      readHandlerDeps: readDeps(),
      writeHandlerDeps: writeDeps(),
    })
    const client = await sseConnect(runtime.port, runtime.localToken)
    expect(client.status).toBe(200)
    eventBus.emit(Events.TaskUpdated, [
      makeDownloadTask({ id: 't1', status: TaskStatus.Downloading }),
    ])
    const frame = await client.waitForFrame()
    expect(frame.event).toBe('$/task/progress')
    expect((frame.data as { taskId: string }).taskId).toBe('t1')
    client.close()
  })

  it('shutdown clears endpoint.json, detaches the SSE source, and disposes device-code timers', async () => {
    const off = vi.fn()
    const emit = vi.fn()
    runtime = await bootstrapBridgeForServer({
      userDataDir,
      host: '127.0.0.1',
      port: 0,
      motrixVersion: '2.0',
      eventBus: { on: vi.fn(), off, emit },
      readHandlerDeps: readDeps(),
      writeHandlerDeps: writeDeps(),
      deviceCodeTtlMs: 30,
    })
    // Arm a pending device-code request's TTL timer BEFORE shutdown.
    await fetch(`http://127.0.0.1:${runtime.port}/mdxp/pair/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientName: 'Agent', clientVersion: '1' }),
    })

    await runtime.shutdown()
    runtime = null
    expect(off).toHaveBeenCalledWith('event:taskUpdated', expect.any(Function))
    await expect(
      readFile(join(userDataDir, 'bridge', 'endpoint.json'))
    ).rejects.toThrow()

    // dispose() itself now terminates the still-pending request synchronously
    // (the renderer's device-code prompt toast has no local TTL, so shutdown
    // must close it rather than leave it stuck with dead buttons) — exactly
    // one PairRequestExpired reaches the (still-alive, process-lifetime)
    // eventBus. Its TTL timer is ALSO cleared, so waiting past the original
    // TTL must not produce a second, duplicate push.
    const expiredCalls = () =>
      emit.mock.calls.filter((c) => c[0] === 'bridge:pairRequestExpired')
    expect(expiredCalls()).toHaveLength(1)

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(expiredCalls()).toHaveLength(1)
  })

  it('stops listener admission before draining pairing persistence', async () => {
    const shutdownOrder: string[] = []
    vi.spyOn(WebSocketBridgeServer.prototype, 'start').mockResolvedValue(19001)
    vi.spyOn(WebSocketBridgeServer.prototype, 'stop').mockImplementation(
      async () => {
        shutdownOrder.push('server')
      }
    )
    vi.spyOn(PairingService.prototype, 'stopAndDrain').mockImplementation(
      async () => {
        shutdownOrder.push('pairing')
      }
    )
    vi.spyOn(BridgeStreamSource.prototype, 'attach').mockImplementation(
      () => {}
    )
    vi.spyOn(BridgeStreamSource.prototype, 'detach').mockImplementation(
      () => {}
    )
    vi.spyOn(EndpointFileWriter.prototype, 'write').mockResolvedValue()
    vi.spyOn(EndpointFileWriter.prototype, 'clear').mockResolvedValue()

    runtime = await bootstrapBridgeForServer({
      userDataDir,
      host: '127.0.0.1',
      port: 0,
      motrixVersion: '2.0',
      eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
      readHandlerDeps: readDeps(),
      writeHandlerDeps: writeDeps(),
    })
    await runtime.shutdown()
    runtime = null

    expect(shutdownOrder).toEqual(['server', 'pairing'])
  })

  it('rolls back a partially-created listener when bind rejects', async () => {
    const bindError = new Error('bind failed after allocation')
    vi.spyOn(WebSocketBridgeServer.prototype, 'start').mockRejectedValue(
      bindError
    )
    const stop = vi
      .spyOn(WebSocketBridgeServer.prototype, 'stop')
      .mockResolvedValue(undefined)
    const attach = vi.spyOn(BridgeStreamSource.prototype, 'attach')

    await expect(
      bootstrapBridgeForServer({
        userDataDir,
        host: '127.0.0.1',
        port: 0,
        motrixVersion: '2.0',
        eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
        readHandlerDeps: readDeps(),
        writeHandlerDeps: writeDeps(),
      })
    ).rejects.toBe(bindError)

    expect(stop).toHaveBeenCalledOnce()
    expect(attach).not.toHaveBeenCalled()
  })

  it('rolls back listener and stream when stream attachment fails', async () => {
    vi.spyOn(WebSocketBridgeServer.prototype, 'start').mockResolvedValue(19001)
    const stop = vi
      .spyOn(WebSocketBridgeServer.prototype, 'stop')
      .mockResolvedValue(undefined)
    const attachError = new Error('stream attach failed')
    let streamLive = false
    vi.spyOn(BridgeStreamSource.prototype, 'attach').mockImplementation(() => {
      streamLive = true
      throw attachError
    })
    const detach = vi
      .spyOn(BridgeStreamSource.prototype, 'detach')
      .mockImplementation(() => {
        streamLive = false
      })
    const write = vi.spyOn(EndpointFileWriter.prototype, 'write')

    await expect(
      bootstrapBridgeForServer({
        userDataDir,
        host: '127.0.0.1',
        port: 0,
        motrixVersion: '2.0',
        eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
        readHandlerDeps: readDeps(),
        writeHandlerDeps: writeDeps(),
      })
    ).rejects.toBe(attachError)

    expect(stop).toHaveBeenCalledOnce()
    expect(detach).toHaveBeenCalledOnce()
    expect(streamLive).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('clears endpoint state and releases stream/listener when endpoint write fails', async () => {
    vi.spyOn(WebSocketBridgeServer.prototype, 'start').mockResolvedValue(19001)
    const stop = vi
      .spyOn(WebSocketBridgeServer.prototype, 'stop')
      .mockResolvedValue(undefined)
    const attach = vi
      .spyOn(BridgeStreamSource.prototype, 'attach')
      .mockImplementation(() => {})
    const detach = vi
      .spyOn(BridgeStreamSource.prototype, 'detach')
      .mockImplementation(() => {})
    const endpointError = new Error('endpoint replace failed')
    vi.spyOn(EndpointFileWriter.prototype, 'write').mockRejectedValue(
      endpointError
    )
    const clear = vi
      .spyOn(EndpointFileWriter.prototype, 'clear')
      .mockResolvedValue(undefined)

    await expect(
      bootstrapBridgeForServer({
        userDataDir,
        host: '127.0.0.1',
        port: 0,
        motrixVersion: '2.0',
        eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
        readHandlerDeps: readDeps(),
        writeHandlerDeps: writeDeps(),
      })
    ).rejects.toBe(endpointError)

    expect(attach).toHaveBeenCalledOnce()
    expect(clear).toHaveBeenCalledOnce()
    expect(detach).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
  })
})
