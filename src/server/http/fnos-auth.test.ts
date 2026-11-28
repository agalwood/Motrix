import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import path from 'node:path'
import { EventBus } from '@core/events/event-bus'
import { BridgeCommands, BridgeQueries } from '@shared/protocol/bridge'
import {
  FNOS_EVENT_PROTOCOL,
  FNOS_EVENT_TICKET_PREFIX,
  WEB_ORIGIN_HEADER,
} from '@shared/schemas/operator-auth'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { parseRemoteExtensionConfig } from '../bridge/remote-extension-config'
import { listenFnos } from '../platform/fnos/runtime'
import { currentNasApprover, currentNasUser } from '../platform/nas/identity'
import { type AppOptions, createApp } from './app'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})
const admin = {
  'x-trim-userid': '1000',
  'x-trim-isadmin': 'true',
  'x-trim-username': 'admin',
  host: 'nas.local',
  origin: 'http://nas.local:5666',
  [WEB_ORIGIN_HEADER]: 'http://nas.local:5666',
}
async function fixture(
  now = Date.now,
  options: Pick<
    AppOptions,
    | 'clientPairing'
    | 'bridgeQueryHandlers'
    | 'bridgeCommandHandlers'
    | 'remoteExtensionConfig'
  > = {}
) {
  const root = await mkdtemp('/tmp/mtx-fnos-')
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  await writeFile(path.join(root, 'index.html'), '<p>Motrix</p>')
  const socketPath = path.join(root, 'app.sock')
  const app = await createApp({
    ...options,
    basePath: '/app/motrix',
    fnosGateway: { socketPath, now },
    rendererDir: root,
    eventBus: new EventBus(),
  })
  app.get('/api/private', async () => ({
    uid: Number(currentNasUser()?.userId),
    approver: currentNasApprover()?.userId,
  }))
  app.post('/api/private', async () => ({
    uid: Number(currentNasUser()?.userId),
    approver: currentNasApprover()?.userId,
  }))
  cleanup.push(() => app.close())
  await listenFnos(app, socketPath)
  const call = (
    url: string,
    headers: Record<string, string | undefined> = admin,
    method = 'GET',
    payload?: unknown
  ) =>
    new Promise<{
      status: number
      body: string
      headers: Record<string, unknown>
    }>((resolve, reject) => {
      const req = request(
        {
          socketPath,
          path: url,
          headers: {
            ...headers,
            ...(payload === undefined
              ? {}
              : { 'content-type': 'application/json' }),
          },
          method,
        },
        (res) => {
          let body = ''
          res.setEncoding('utf8').on('data', (chunk) => {
            body += chunk
          })
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body, headers: res.headers })
          )
        }
      )
      req
        .on('error', reject)
        .end(payload === undefined ? undefined : JSON.stringify(payload))
    })
  return { app, call, socketPath }
}

describe('fnOS gateway control plane', () => {
  it('does not let an HTTPS operator URL authorize a code on a different gateway browser origin', async () => {
    const claim = vi.fn(async () => ({
      ok: true,
      code: 'ABCD-EFGH',
      expiresInMs: 1000,
    }))
    const { call } = await fixture(Date.now, {
      remoteExtensionConfig: parseRemoteExtensionConfig(
        {
          MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
          MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: 'wss://bridge.example',
          MOTRIX_PUBLIC_URL: 'https://nas.local/app/motrix/',
        },
        { requireWebOperator: true }
      ),
      bridgeCommandHandlers: { [BridgeCommands.ClaimExtensionPair]: claim },
    })
    const url = `/app/motrix/rpc/command/${encodeURIComponent(BridgeCommands.ClaimExtensionPair)}`
    for (const origin of [
      'http://nas.local',
      'https://other.example',
      'https://nas.local:5666',
    ]) {
      const response = await call(
        url,
        { ...admin, origin, [WEB_ORIGIN_HEADER]: origin },
        'POST',
        { args: [] }
      )
      expect(response.status).toBe(403)
      expect(response.body).not.toContain('ABCD-EFGH')
    }
    expect(claim).not.toHaveBeenCalled()
    expect(
      (
        await call(
          url,
          {
            ...admin,
            origin: 'https://nas.local',
            [WEB_ORIGIN_HEADER]: 'https://nas.local',
          },
          'POST',
          { args: [] }
        )
      ).status
    ).toBe(200)
    expect(claim).toHaveBeenCalledOnce()
  })
  it.each([false, true])(
    'gates claimed-code delivery on explicit operator transport consent (%s)',
    async (consent) => {
      const claim = vi.fn(async () => {
        expect(currentNasApprover()?.userId).toBe('1000')
        return { ok: true, code: 'ABCD-EFGH', expiresInMs: 1000 }
      })
      const { call } = await fixture(Date.now, {
        remoteExtensionConfig: parseRemoteExtensionConfig({
          MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
          MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: 'ws://nas.local:16802',
          ...(consent ? { MOTRIX_ALLOW_INSECURE_OPERATOR_HTTP: 'true' } : {}),
        }),
        bridgeCommandHandlers: { [BridgeCommands.ClaimExtensionPair]: claim },
      })
      const url = `/app/motrix/rpc/command/${encodeURIComponent(BridgeCommands.ClaimExtensionPair)}`
      const body = {
        args: [
          {
            browser: 'chromium',
            extensionId: 'a'.repeat(32),
            pairingNonce: 'nonce',
          },
        ],
      }
      const response = await call(url, admin, 'POST', body)
      expect(response.status).toBe(consent ? 200 : 403)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(claim).toHaveBeenCalledTimes(consent ? 1 : 0)
      if (consent) expect(JSON.parse(response.body).code).toBe('ABCD-EFGH')
      else expect(response.body).not.toContain('ABCD-EFGH')
      expect(
        (await call(url, { ...admin, 'x-trim-isadmin': 'false' }, 'POST', body))
          .status
      ).toBe(401)
      expect(
        (
          await call(
            url,
            { ...admin, origin: 'http://evil.example' },
            'POST',
            body
          )
        ).status
      ).toBe(403)
      expect(claim).toHaveBeenCalledTimes(consent ? 1 : 0)
    }
  )
  it('advertises configured CLI pairing and serves its inbox through the administrator gate', async () => {
    const entries = [
      {
        kind: 'cli',
        requestId: 'request',
        userCode: 'ABCD-EFGH',
        clientName: 'CLI',
        clientVersion: '1',
        expiresAt: Date.now() + 10000,
      },
    ]
    const pending = vi.fn(async () => entries)
    const { call } = await fixture(Date.now, {
      clientPairing: { cli: true, extension: false },
      bridgeQueryHandlers: { [BridgeQueries.ListPendingPairRequests]: pending },
    })
    const status = JSON.parse((await call('/app/motrix/rpc/auth/status')).body)
    expect(status.clientPairing).toEqual({ cli: true, extension: false })
    const url = `/app/motrix/rpc/query/${encodeURIComponent(BridgeQueries.ListPendingPairRequests)}`
    expect(JSON.parse((await call(url, admin, 'POST')).body)).toEqual(entries)
    expect(
      (await call(url, { ...admin, 'x-trim-isadmin': 'false' }, 'POST')).status
    ).toBe(401)
    expect(pending).toHaveBeenCalledOnce()
  })
  it('returns an empty pairing inbox only to authenticated fnOS administrators', async () => {
    const { call } = await fixture()
    const url = `/app/motrix/rpc/query/${encodeURIComponent(BridgeQueries.ListPendingPairRequests)}`
    const result = await call(url, admin, 'POST')
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toEqual([])
    expect((await call(url, {}, 'POST')).status).toBe(401)
  })
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
      approver: '1000',
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
  it('loads static assets and authenticates RPC after the gateway drops the Host port', async () => {
    const { call } = await fixture()
    expect((await call('/app/motrix/index.html')).status).toBe(200)
    expect((await call('/app/motrix/api/private', admin, 'POST')).status).toBe(
      200
    )
    const { [WEB_ORIGIN_HEADER]: _marker, ...withoutMarker } = admin
    expect(
      (await call('/app/motrix/api/private', withoutMarker, 'POST')).status
    ).toBe(403)
    expect(
      (
        await call(
          '/app/motrix/api/private',
          { ...admin, origin: 'http://nas.local:8080' },
          'POST'
        )
      ).status
    ).toBe(403)
    expect(
      (
        await call(
          '/app/motrix/api/private',
          { ...admin, 'sec-fetch-site': 'cross-site' },
          'POST'
        )
      ).status
    ).toBe(403)
    const preflight = await call(
      '/app/motrix/api/private',
      {
        ...withoutMarker,
        origin: 'https://evil.example',
        'access-control-request-headers': WEB_ORIGIN_HEADER,
      },
      'OPTIONS'
    )
    expect(preflight.status).toBe(403)
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined()
  })
  it('accepts a fresh origin-bound ticket when the gateway omits websocket identity headers', async () => {
    const { call, socketPath } = await fixture()
    const issued = await call(
      '/app/motrix/rpc/auth/event-ticket',
      admin,
      'POST'
    )
    expect(issued.headers['cache-control']).toBe('no-store')
    const { ticket } = JSON.parse(issued.body)
    const protocols = [
      FNOS_EVENT_PROTOCOL,
      `${FNOS_EVENT_TICKET_PREFIX}${ticket}`,
    ]
    const socket = new WebSocket(
      `ws+unix://${socketPath}:/app/motrix/rpc/events`,
      protocols,
      { headers: { host: 'nas.local', origin: admin.origin } }
    )
    await once(socket, 'open')
    socket.close()
    await once(socket, 'close')
    expect(
      await rejectedUpgrade(socketPath, protocols, { origin: admin.origin })
    ).toBe(401)
  })
  it('rejects expired tickets, different origins, changed users, ordinary users and ticketless upgrades', async () => {
    let clock = Date.now()
    const { call, socketPath } = await fixture(() => clock)
    const issue = async () => {
      const issued = await call(
        '/app/motrix/rpc/auth/event-ticket',
        admin,
        'POST'
      )
      return [
        FNOS_EVENT_PROTOCOL,
        `${FNOS_EVENT_TICKET_PREFIX}${JSON.parse(issued.body).ticket}`,
      ]
    }
    expect(await rejectedUpgrade(socketPath, undefined, admin)).toBe(401)
    expect(
      await rejectedUpgrade(socketPath, await issue(), {
        origin: 'http://nas.local:8080',
      })
    ).toBe(403)
    expect(
      await rejectedUpgrade(socketPath, await issue(), {
        ...admin,
        'x-trim-userid': '2000',
      })
    ).toBe(401)
    expect(
      await rejectedUpgrade(socketPath, await issue(), {
        ...admin,
        'x-trim-isadmin': 'false',
      })
    ).toBe(401)
    const expired = await issue()
    clock += 30_001
    expect(
      await rejectedUpgrade(socketPath, expired, { origin: admin.origin })
    ).toBe(401)
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

async function rejectedUpgrade(
  socketPath: string,
  protocols: string[] | undefined,
  headers: Record<string, string>
): Promise<number> {
  const rejected = new WebSocket(
    `ws+unix://${socketPath}:/app/motrix/rpc/events`,
    protocols,
    { headers }
  )
  return new Promise((resolve, reject) => {
    rejected.once('unexpected-response', (_req, res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
      rejected.terminate()
    })
    rejected.once('error', reject)
    rejected.once('open', () => {
      rejected.terminate()
      reject(new Error('Unexpected authorization'))
    })
  })
}
