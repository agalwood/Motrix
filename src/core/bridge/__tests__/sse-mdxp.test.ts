import { request as httpRequest } from 'node:http'
import { DeviceCodeService } from '@core/bridge/device-code-service'
import type { PairedClient, PairingService } from '@core/bridge/pairing-service'
import { WebSocketBridgeServer } from '@core/bridge/web-socket-bridge-server'
import type { ClientIdentity } from '@shared/protocol/bridge'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeFakePairing, makeFakeRegistry, makeInMemoryPairing } from './fakes'

const LOCAL_TOKEN = 'sse-local-token'

interface SseClient {
  status: number
  waitForFrame: () => Promise<{ event: string; data: unknown }>
  /** Resolves when the server ends the stream (res 'end'/'close'). */
  closed: Promise<void>
  close: () => void
}

/** Open an SSE stream and parse `event:`/`data:` frames (skipping `:` comments). */
function sseConnect(port: number, token: string | null): Promise<SseClient> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { accept: 'text/event-stream' }
    if (token != null) headers.authorization = `Bearer ${token}`
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/mdxp/events', method: 'GET', headers },
      (res) => {
        const queue: Array<{ event: string; data: unknown }> = []
        const waiters: Array<(f: { event: string; data: unknown }) => void> = []
        let resolveClosed: () => void = () => {}
        const closed = new Promise<void>((r) => {
          resolveClosed = r
        })
        res.on('end', () => resolveClosed())
        res.on('close', () => resolveClosed())
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
                const body = line.slice(5).trim()
                try {
                  data = JSON.parse(body)
                } catch {
                  data = body
                }
              }
            }
            const frame = { event, data }
            const w = waiters.shift()
            if (w) w(frame)
            else queue.push(frame)
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
          closed,
          close: () => req.destroy(),
        })
      }
    )
    req.on('error', () => {})
    req.end()
  })
}

describe('SSE GET /mdxp/events', () => {
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
    port = await server.start()
  })

  afterEach(async () => {
    // Must resolve even with an open SSE client (stop() ends streams before
    // http.close(), else this hangs).
    await server.stop()
  })

  it('rejects a missing token with 401', async () => {
    const c = await sseConnect(port, null)
    expect(c.status).toBe(401)
  })

  it('rejects a wrong token with 401', async () => {
    const c = await sseConnect(port, 'nope')
    expect(c.status).toBe(401)
  })

  it('streams a broadcast frame to an authed client', async () => {
    const c = await sseConnect(port, LOCAL_TOKEN)
    expect(c.status).toBe(200)
    server.broadcastStreamEvent('$/task/progress', {
      taskId: 't1',
      phase: 'downloading',
    })
    const frame = await c.waitForFrame()
    expect(frame.event).toBe('$/task/progress')
    expect(frame.data).toMatchObject({ taskId: 't1', phase: 'downloading' })
    c.close()
  })

  it('broadcasts to multiple clients and survives one closing', async () => {
    const a = await sseConnect(port, LOCAL_TOKEN)
    const b = await sseConnect(port, LOCAL_TOKEN)
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    a.close()
    // give the close a tick to propagate
    await new Promise((r) => setTimeout(r, 20))
    server.broadcastStreamEvent('$/stats', { activeTasks: 2 })
    const frame = await b.waitForFrame()
    expect(frame.event).toBe('$/stats')
    expect(frame.data).toMatchObject({ activeTasks: 2 })
    b.close()
  })
})

/** Resolve to 'resolved' if `p` settles within `ms`, else 'timeout'. */
function withinTimeout(p: Promise<unknown>, ms: number): Promise<string> {
  return Promise.race([
    p.then(() => 'resolved'),
    new Promise<string>((r) => setTimeout(() => r('timeout'), ms)),
  ])
}

describe('SSE revocation closes live streams', () => {
  const CLI_TOKEN = 'cli-firehose-token'
  const cliIdentity: ClientIdentity = { kind: 'cli', id: 'agent-1' }
  const cliClient: PairedClient = {
    identity: cliIdentity,
    token: CLI_TOKEN,
    name: 'Agent One',
    pairedAt: 0,
    lastActiveAt: null,
  }
  let server: WebSocketBridgeServer
  let pairing: PairingService
  let port: number

  beforeEach(async () => {
    pairing = makeFakePairing({ [CLI_TOKEN]: cliClient })
    server = new WebSocketBridgeServer({
      pairing,
      registry: makeFakeRegistry(),
      motrixVersion: '2.0',
      runtime: 'electron',
      ffmpegAvailable: true,
      localToken: LOCAL_TOKEN,
    })
    port = await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('closes the SSE stream of a revoked cli identity', async () => {
    const c = await sseConnect(port, CLI_TOKEN)
    expect(c.status).toBe(200)
    pairing.emit('revoked', { identity: cliIdentity, reason: 'user-revoked' })
    expect(await withinTimeout(c.closed, 500)).toBe('resolved')
  })

  it('closes the SSE stream of a rotated cli identity', async () => {
    const c = await sseConnect(port, CLI_TOKEN)
    expect(c.status).toBe(200)
    pairing.emit('rotated', { identity: cliIdentity })
    expect(await withinTimeout(c.closed, 500)).toBe('resolved')
  })

  it('leaves other identities streaming when one is revoked', async () => {
    const revoked = await sseConnect(port, CLI_TOKEN)
    const survivor = await sseConnect(port, LOCAL_TOKEN)
    expect(revoked.status).toBe(200)
    expect(survivor.status).toBe(200)

    pairing.emit('revoked', { identity: cliIdentity, reason: 'user-revoked' })
    expect(await withinTimeout(revoked.closed, 500)).toBe('resolved')

    // The machine-owner (localToken) stream is untouched and still receives.
    server.broadcastStreamEvent('$/stats', { activeTasks: 7 })
    const frame = await survivor.waitForFrame()
    expect(frame.event).toBe('$/stats')
    expect(frame.data).toMatchObject({ activeTasks: 7 })
    survivor.close()
  })
})

/** Minimal JSON POST helper for the device-code HTTP routes. */
function postJson(
  port: number,
  path: string,
  body: unknown
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = ''
        res.setEncoding('utf-8')
        res.on('data', (c: string) => {
          data += c
        })
        res.on('end', () => resolve(data ? JSON.parse(data) : {}))
      }
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

describe('SSE rotation on device-code re-pair (end-to-end)', () => {
  // A valid client-generated device handle: base64url, length within [16, 64].
  const DEVICE_ID = 'ZGV2aWNlLWhhbmRsZS0xMjM0'
  let server: WebSocketBridgeServer
  let pairing: PairingService
  let deviceCode: DeviceCodeService
  let port: number

  beforeEach(async () => {
    pairing = makeInMemoryPairing()
    await pairing.load()
    deviceCode = new DeviceCodeService(pairing)
    server = new WebSocketBridgeServer({
      pairing,
      registry: makeFakeRegistry(),
      motrixVersion: '2.0',
      runtime: 'electron',
      ffmpegAvailable: true,
      localToken: LOCAL_TOKEN,
      deviceCode,
    })
    port = await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  /** Drive a full pair: request (with the device handle) → operator approve →
   *  poll for the issued token. Returns the token. */
  async function pairWithDevice(): Promise<string> {
    const req = await postJson(port, '/mdxp/pair/request', {
      clientName: 'Agent',
      deviceId: DEVICE_ID,
    })
    const requestId = req.requestId as string
    await deviceCode.approve(requestId)
    const poll = await postJson(port, '/mdxp/pair/poll', { requestId })
    return poll.token as string
  }

  it('re-pairing the same deviceId rotates the token and closes the old SSE', async () => {
    const token1 = await pairWithDevice()
    const sse = await sseConnect(port, token1)
    expect(sse.status).toBe(200)

    // The same agent pairs again (same persisted device handle) → rotation.
    const token2 = await pairWithDevice()
    expect(token2).not.toBe(token1)

    // The old token's firehose is dropped, the old token is dead, the new lives.
    expect(await withinTimeout(sse.closed, 500)).toBe('resolved')
    expect(pairing.findByToken(token1)).toBeNull()
    expect(pairing.findByToken(token2)?.identity).toMatchObject({ kind: 'cli' })
  })
})
