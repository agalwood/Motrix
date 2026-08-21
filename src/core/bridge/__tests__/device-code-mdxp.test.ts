import { request as httpRequest } from 'node:http'
import { DeviceCodeService } from '@core/bridge/device-code-service'
import { WebSocketBridgeServer } from '@core/bridge/web-socket-bridge-server'
import type { PairRequestPayload } from '@shared/protocol/bridge'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeFakeRegistry, makeStatefulFakePairing } from './fakes'

interface HttpResult {
  status: number
  body: Record<string, unknown>
  headers: Record<string, string | string[] | undefined>
}

function httpJson(
  port: number,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: payload
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        let data = ''
        res.setEncoding('utf-8')
        res.on('data', (c: string) => {
          data += c
        })
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: data ? JSON.parse(data) : {},
            headers: res.headers,
          })
        })
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

describe('device-code HTTP endpoints', () => {
  let server: WebSocketBridgeServer
  let deviceCode: DeviceCodeService
  let port: number
  let prompts: PairRequestPayload[]

  beforeEach(async () => {
    deviceCode = new DeviceCodeService(makeStatefulFakePairing())
    prompts = []
    server = new WebSocketBridgeServer({
      pairing: makeStatefulFakePairing(),
      registry: makeFakeRegistry(),
      motrixVersion: '2.0',
      runtime: 'electron',
      ffmpegAvailable: true,
      localToken: 'local',
      deviceCode,
      onPairRequested: (p) => prompts.push(p),
    })
    port = await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('POST /mdxp/pair/request returns a code and fires an approval prompt', async () => {
    const res = await httpJson(port, 'POST', '/mdxp/pair/request', {
      clientName: 'Motrix CLI',
      clientVersion: '1.0.0',
    })
    expect(res.status).toBe(200)
    expect(res.body.requestId).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(res.body.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    // No verificationUri injected → omitted (never the bridge's own host).
    expect(res.body.verificationUri).toBeUndefined()
    expect(typeof res.body.expiresAt).toBe('number')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({
      kind: 'cli',
      requestId: res.body.requestId,
      userCode: res.body.userCode,
      clientName: 'Motrix CLI',
    })
  })

  it('rejects a request with no clientName', async () => {
    const res = await httpJson(port, 'POST', '/mdxp/pair/request', {})
    expect(res.status).toBe(400)
  })

  it('POST /mdxp/pair/poll reports pending then approved+token (once)', async () => {
    const reqRes = await httpJson(port, 'POST', '/mdxp/pair/request', {
      clientName: 'Motrix CLI',
    })
    const requestId = reqRes.body.requestId as string

    const pending = await httpJson(port, 'POST', '/mdxp/pair/poll', {
      requestId,
    })
    expect(pending.body).toEqual({ status: 'pending' })

    // Simulate the user approving in the UI.
    await deviceCode.approve(requestId)

    const approved = await httpJson(port, 'POST', '/mdxp/pair/poll', {
      requestId,
    })
    expect(approved.body.status).toBe('approved')
    expect(typeof approved.body.token).toBe('string')

    // One-time delivery: a replayed poll gets nothing.
    const replay = await httpJson(port, 'POST', '/mdxp/pair/poll', {
      requestId,
    })
    expect(replay.body).toEqual({ status: 'expired' })
  })

  it('sets Cache-Control: no-store on poll responses', async () => {
    const r = await httpJson(port, 'POST', '/mdxp/pair/poll', {
      requestId: 'x',
    })
    expect(r.headers['cache-control']).toBe('no-store')
  })

  it('poll without a requestId is a 400', async () => {
    const res = await httpJson(port, 'POST', '/mdxp/pair/poll', {})
    expect(res.status).toBe(400)
  })

  it('unknown requestId polls as expired', async () => {
    const res = await httpJson(port, 'POST', '/mdxp/pair/poll', {
      requestId: 'nope',
    })
    expect(res.body).toEqual({ status: 'expired' })
  })
})

describe('device-code verificationUri', () => {
  let server: WebSocketBridgeServer
  let port: number

  afterEach(async () => {
    await server.stop()
  })

  it('returns the injected verificationUri verbatim (never the request Host)', async () => {
    server = new WebSocketBridgeServer({
      pairing: makeStatefulFakePairing(),
      registry: makeFakeRegistry(),
      motrixVersion: '2.0',
      runtime: 'electron',
      ffmpegAvailable: true,
      localToken: 'local',
      deviceCode: new DeviceCodeService(makeStatefulFakePairing()),
      verificationUri: 'https://ui.example.test/approve',
    })
    port = await server.start()
    const res = await httpJson(port, 'POST', '/mdxp/pair/request', {
      clientName: 'CLI',
    })
    expect(res.body.verificationUri).toBe('https://ui.example.test/approve')
    // Crucially NOT derived from the bridge's own host:port.
    expect(String(res.body.verificationUri)).not.toContain(String(port))
  })
})

describe('device-code endpoints disabled when no DeviceCodeService', () => {
  let server: WebSocketBridgeServer
  let port: number

  beforeEach(async () => {
    server = new WebSocketBridgeServer({
      pairing: makeStatefulFakePairing(),
      registry: makeFakeRegistry(),
      motrixVersion: '2.0',
      runtime: 'electron',
      ffmpegAvailable: true,
      localToken: 'local',
    })
    port = await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('404s pair/request and pair/poll when device-code is not configured', async () => {
    const r1 = await httpJson(port, 'POST', '/mdxp/pair/request', {
      clientName: 'X',
    })
    expect(r1.status).toBe(404)
    const r2 = await httpJson(port, 'POST', '/mdxp/pair/poll', {
      requestId: 'x',
    })
    expect(r2.status).toBe(404)
  })
})
