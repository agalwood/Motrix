import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import path from 'node:path'
import { EventBus } from '@core/events/event-bus'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { fnosUser } from '../platform/fnos/files'
import { listenFnos } from '../platform/fnos/runtime'
import { createApp } from './app'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})
const admin = {
  'x-trim-userid': '1000',
  'x-trim-isadmin': 'true',
  'x-trim-username': 'admin',
  host: 'nas.local',
}
async function fixture() {
  const root = await mkdtemp('/tmp/mtx-fnos-')
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  await writeFile(path.join(root, 'index.html'), '<p>Motrix</p>')
  const socketPath = path.join(root, 'app.sock')
  const app = await createApp({
    basePath: '/app/motrix',
    fnosGateway: { socketPath },
    rendererDir: root,
    eventBus: new EventBus(),
  })
  app.get('/api/private', async () => ({ uid: fnosUser.getStore() }))
  cleanup.push(() => app.close())
  await listenFnos(app, socketPath)
  const call = (
    url: string,
    headers: Record<string, string | undefined> = admin,
    method = 'GET'
  ) =>
    new Promise<{
      status: number
      body: string
      headers: Record<string, unknown>
    }>((resolve, reject) => {
      const req = request({ socketPath, path: url, headers, method }, (res) => {
        let body = ''
        res.setEncoding('utf8').on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers })
        )
      })
      req.on('error', reject).end()
    })
  return { app, call, socketPath }
}

describe('fnOS gateway control plane', () => {
  it('authenticates administrators on the Unix socket and binds their UID', async () => {
    const { call } = await fixture()
    const status = await call('/app/motrix/rpc/auth/status')
    expect(status.status).toBe(200)
    expect(JSON.parse(status.body)).toMatchObject({
      mode: 'fnosGateway',
      canLogout: false,
      username: 'admin',
    })
    expect(JSON.parse((await call('/app/motrix/api/private')).body)).toEqual({
      uid: 1000,
    })
    expect(
      (
        await call('/app/motrix/api/private', {
          ...admin,
          'x-trim-userid': '2000',
        })
      ).body
    ).toContain('2000')
  })
  it('rejects ordinary users, malformed identities, bearer fallbacks and root-path bypasses', async () => {
    const { call } = await fixture()
    for (const headers of [
      {},
      { ...admin, 'x-trim-isadmin': 'false' },
      { ...admin, 'x-trim-userid': '1e3' },
      { ...admin, 'x-trim-userid': '1000,1001' },
      { authorization: 'Bearer secret' },
    ]) {
      expect((await call('/app/motrix/api/private', headers)).status).toBe(401)
    }
    for (const url of [
      '/api/private',
      '/app/motrix-other/api/private',
      '/app/motrix%2fapi/private',
    ])
      expect((await call(url)).status).toBe(404)
    expect(
      (await call('/app/motrix/rpc/auth/login', admin, 'POST')).status
    ).toBe(404)
    expect((await call('/app/motrix/api/missing')).status).toBe(404)
    expect((await call('/app/motrix/healthz', {})).status).toBe(200)
  })
  it('rejects gateway headers on a TCP listener', async () => {
    const app = await createApp({
      fnosGateway: { socketPath: '/tmp/not-this-listener.sock' },
    })
    cleanup.push(() => app.close())
    await app.listen({ host: '127.0.0.1', port: 0 })
    expect(
      (await app.inject({ url: '/rpc/auth/status', headers: admin })).statusCode
    ).toBe(401)
  })
  it('preserves query strings on the slash redirect and refuses cross-origin mutations', async () => {
    const { call } = await fixture()
    expect(
      (await call('/app/motrix?path=example.torrent')).headers.location
    ).toBe('/app/motrix/?path=example.torrent')
    expect(
      (
        await call(
          '/app/motrix/rpc/command/missing',
          { ...admin, origin: 'https://evil.example' },
          'POST'
        )
      ).status
    ).toBe(403)
  })
  it('checks identity and Origin before upgrading a websocket', async () => {
    const { socketPath } = await fixture()
    const socket = new WebSocket(
      `ws+unix://${socketPath}:/app/motrix/rpc/events`,
      {
        socketPath,
        headers: { ...admin, origin: 'http://nas.local' },
      }
    )
    await once(socket, 'open')
    socket.close()
    await once(socket, 'close')
    const rejected = new WebSocket(
      `ws+unix://${socketPath}:/app/motrix/rpc/events`,
      {
        socketPath,
        headers: { ...admin, origin: 'http://evil.example' },
      }
    )
    const response = await new Promise<number>((resolve, reject) => {
      rejected.once('unexpected-response', (_req, res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
        rejected.terminate()
      })
      rejected.once('error', reject)
    })
    expect(response).toBe(403)
  })
  it('does not unlink a live socket or a regular file', async () => {
    const { socketPath } = await fixture()
    const other = await createApp()
    cleanup.push(() => other.close())
    await expect(listenFnos(other, socketPath)).rejects.toThrow(
      'already listening'
    )
    const file = `${socketPath}.file`
    await writeFile(file, 'keep')
    await expect(listenFnos(other, file)).rejects.toThrow('unowned')
  })
})
