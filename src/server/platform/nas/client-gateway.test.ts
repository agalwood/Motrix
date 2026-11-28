import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { listenNasClientGateway } from './client-gateway'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture() {
  const root = await mkdtemp('/tmp/mtx-nas-gateway-')
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const seen: {
    url: string | undefined
    cookie: string | undefined
    authorization: string | undefined
    identity: unknown
  }[] = []
  const upstream = createServer((req, res) => {
    seen.push({
      url: req.url,
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
      identity: req.headers['x-trim-userid'],
    })
    res.setHeader('set-cookie', 'must-not-forward')
    res.end('ok')
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  cleanups.push(
    () => new Promise<void>((resolve) => upstream.close(() => resolve()))
  )
  const address = upstream.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing test listener')
  let currentPort: number | undefined = address.port,
    enabled = false
  const socketPath = path.join(root, 'client.sock')
  const gateway = await listenNasClientGateway({
    socketPath,
    currentPort: () => currentPort,
    extensionEnabled: () => enabled,
  })
  cleanups.push(() => gateway.close())
  const call = (url: string, method = 'POST') =>
    new Promise<{
      status: number | undefined
      cookie: unknown
      cache: unknown
    }>((resolve, reject) => {
      const req = request(
        {
          socketPath,
          path: url,
          method,
          headers: {
            host: 'nas.test:5001',
            cookie: 'id=private-test-cookie',
            authorization: 'Bearer test-credential',
            'x-trim-userid': '1700',
          },
        },
        (res) => {
          res.resume()
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              cookie: res.headers['set-cookie'],
              cache: res.headers['cache-control'],
            })
          )
        }
      )
      req.on('error', reject)
      req.end()
    })
  return {
    upstream,
    gateway,
    socketPath,
    seen,
    call,
    enable: () => {
      enabled = true
    },
    unavailable: () => {
      currentPort = undefined
    },
  }
}
describe.skipIf(process.platform === 'win32')(
  'NAS client HTTPS gateway',
  () => {
    it('preserves CLI bearer auth and rewrites only known routes, stripping DSM identity and cookies', async () => {
      const f = await fixture()
      expect(await f.call('/motrix/client/mdxp')).toEqual({
        status: 200,
        cookie: undefined,
        cache: 'no-store',
      })
      expect(f.seen).toEqual([
        {
          url: '/mdxp',
          cookie: undefined,
          authorization: 'Bearer test-credential',
          identity: undefined,
        },
      ])
      for (const url of [
        '/motrix/client/mdxp?token=bad',
        '/motrix/client/../mdxp',
        '/motrix/client/mdxp/unknown',
        '/motrix/bridge/nonce',
      ])
        expect((await f.call(url)).status).toBe(404)
      expect(f.seen).toHaveLength(1)
      f.unavailable()
      expect((await f.call('/motrix/client/mdxp')).status).toBe(503)
    })
    it('keeps extension requests closed until enabled and retains the raw public prefix', async () => {
      const f = await fixture()
      f.enable()
      expect((await f.call('/motrix/bridge/nonce')).status).toBe(200)
      expect(f.seen[0]).toEqual({
        url: '/motrix/bridge/nonce',
        cookie: undefined,
        authorization: undefined,
        identity: undefined,
      })
    })
    it('rejects duplicate Host fields before any upstream request', async () => {
      const f = await fixture()
      f.enable()
      const response = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(f.socketPath)
        let value = ''
        socket.on('connect', () =>
          socket.end(
            'GET /motrix/bridge/discovery HTTP/1.1\r\nHost: nas.test:5001\r\nHost: other.test\r\nConnection: close\r\n\r\n'
          )
        )
        socket.on('data', (chunk) => {
          value += chunk
        })
        socket.on('end', () => resolve(value))
        socket.on('error', reject)
      })
      expect(response).toMatch(/^HTTP\/1.1 (400|404)/)
      expect(f.seen).toHaveLength(0)
    })
    it('forwards websocket bytes unchanged and closes the connection with the gateway', async () => {
      const f = await fixture()
      f.enable()
      const wss = new WebSocketServer({ noServer: true })
      f.upstream.on('upgrade', (req, socket, head) => {
        expect(req.url).toBe('/motrix/bridge/v1')
        expect(req.headers.cookie).toBeUndefined()
        wss.handleUpgrade(req, socket, head, (ws) =>
          ws.on('message', (data) => ws.send(data))
        )
      })
      const ws = new WebSocket(`ws+unix:${f.socketPath}:/motrix/bridge/v1`, {
        headers: { host: 'nas.test:5001', cookie: 'private' },
      })
      await once(ws, 'open')
      const message = once(ws, 'message')
      ws.send(Buffer.from([1, 2, 3]))
      expect((await message)[0]).toEqual(Buffer.from([1, 2, 3]))
      const closed = once(ws, 'close')
      await f.gateway.close()
      await closed
      wss.close()
    })
  }
)
