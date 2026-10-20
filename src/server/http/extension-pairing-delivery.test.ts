import { EventBus } from '@core/events/event-bus'
import { BridgeEvents, BridgeQueries } from '@shared/protocol/bridge'
import { Events } from '@shared/protocol/events'
import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { parseRemoteExtensionConfig } from '../bridge/remote-extension-config'
import { createApp } from './app'
import { canDeliverExtensionPairingCode } from './extension-pairing-delivery'

const config = parseRemoteExtensionConfig({
  MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
  MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: 'ws://192.168.1.2:16801',
})
const request = (
  headers = ['Host', '127.0.0.1:8080'],
  remoteAddress = '127.0.0.1',
  localPort: number | undefined = 8080
) =>
  ({
    raw: { rawHeaders: headers, socket: { remoteAddress, localPort } },
  }) as FastifyRequest

describe('Extension pairing code delivery', () => {
  it('admits only an authenticated direct loopback operator in local mode', () => {
    expect(canDeliverExtensionPairingCode(config, request(), true)).toBe(true)
    expect(canDeliverExtensionPairingCode(config, request(), false)).toBe(false)
    expect(
      canDeliverExtensionPairingCode(
        config,
        request(['Host', '[::1]:8080'], '::1'),
        true
      )
    ).toBe(true)
    expect(
      canDeliverExtensionPairingCode(
        config,
        request(undefined, '::ffff:127.0.0.1'),
        true
      )
    ).toBe(true)
  })
  it.each([
    ['Origin', ''],
    ['Origin', 'http://127.0.0.1:8080'],
    ['Forwarded', ''],
    ['X-Forwarded-For', '127.0.0.1'],
    ['X-Forwarded-Host', ''],
    ['X-Forwarded-Proto', 'https'],
  ])('rejects the local exception when %s is present', (name, value) => {
    expect(
      canDeliverExtensionPairingCode(
        config,
        request(['Host', '127.0.0.1:8080', name, value]),
        true
      )
    ).toBe(false)
  })
  it.each(
    [
      [],
      ['Host', 'localhost:8081'],
      ['Host', 'evil.example:8080'],
      ['Host', '127.0.0.1:8080', 'host', '127.0.0.1:8080'],
      ['Host', '127.0.0.1:8080 '],
      ['Host', '127.0.0.1'],
    ].map((headers) => ({ headers }))
  )('rejects missing, duplicate or mismatched Host $headers', ({ headers }) => {
    expect(canDeliverExtensionPairingCode(config, request(headers), true)).toBe(
      false
    )
  })
  it('ignores forwarded locality and requires a parser-issued enabled config', () => {
    expect(
      canDeliverExtensionPairingCode(
        config,
        request(undefined, '192.168.1.3'),
        true
      )
    ).toBe(false)
    expect(canDeliverExtensionPairingCode(undefined, request(), true)).toBe(
      false
    )
    expect(canDeliverExtensionPairingCode({ ...config }, request(), true)).toBe(
      false
    )
    expect(
      canDeliverExtensionPairingCode(
        parseRemoteExtensionConfig({}),
        request(),
        true
      )
    ).toBe(false)
  })
  it.each([
    { MOTRIX_PUBLIC_URL: 'https://operator.example' },
    { MOTRIX_ALLOW_INSECURE_OPERATOR_HTTP: 'true' },
    {
      MOTRIX_PUBLIC_URL: 'http://nas.local:8080',
      MOTRIX_ALLOW_INSECURE_OPERATOR_HTTP: 'true',
    },
  ])('preserves explicit Web delivery for %j', (env) => {
    const web = parseRemoteExtensionConfig({
      MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
      MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: 'wss://bridge.example',
      ...env,
    })
    expect(
      canDeliverExtensionPairingCode(
        web,
        request(undefined, '192.168.1.3'),
        false
      )
    ).toBe(true)
  })

  it('filters both authenticated Web snapshots and events while local Bearer can read', async () => {
    const token = 'owner-token'
    const extension = {
      kind: 'extension',
      pairingNonce: 'n'.repeat(43),
      extensionId: 'a'.repeat(32),
      browser: 'chromium',
      identity: 'unverified',
      code: '0123-4567',
      createdAt: 1,
      expiresAt: Date.now() + 120_000,
    }
    const cli = { kind: 'cli', requestId: 'cli-request', userCode: 'ABCD-EFGH' }
    const bus = new EventBus()
    const app = await createApp({
      eventBus: bus,
      remoteExtensionConfig: config,
      operatorAuth: { operatorToken: token },
      bridgeQueryHandlers: {
        [BridgeQueries.ListPendingPairRequests]: async () => [extension, cli],
      },
    })
    let ws: WebSocket | undefined
    try {
      const base = await app.listen({ host: '127.0.0.1', port: 0 })
      const login = await fetch(`${base}/rpc/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const cookie = login.headers.get('set-cookie')!.split(';')[0]
      const url = `${base}/rpc/query/${encodeURIComponent(BridgeQueries.ListPendingPairRequests)}`
      const read = (headers: Record<string, string>) =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ args: [] }),
        })
      expect(
        await (await read({ authorization: `Bearer ${token}` })).json()
      ).toEqual([extension, cli])
      expect(await (await read({ cookie, origin: base })).json()).toEqual([cli])
      expect(
        await (
          await read({
            authorization: `Bearer ${token}`,
            'x-forwarded-proto': 'https',
          })
        ).json()
      ).toEqual([cli])
      const unauthorized = await read({ authorization: 'Bearer agent-token' })
      expect(unauthorized.status).toBe(401)
      expect(await unauthorized.text()).not.toContain(extension.code)
      ws = new WebSocket(`${base.replace('http:', 'ws:')}/rpc/events`, {
        headers: { cookie, origin: base },
      })
      await new Promise<void>((resolve, reject) => {
        ws!.once('open', resolve)
        ws!.once('error', reject)
      })
      const messages: string[] = []
      ws.on('message', (data) => messages.push(String(data)))
      const end = new Promise<void>((resolve) => {
        ws!.on('message', (data) => {
          if (String(data).includes(Events.TaskUpdated)) resolve()
        })
      })
      bus.emit(BridgeEvents.PairRequested as never, extension)
      bus.emit(BridgeEvents.PairRequested as never, cli)
      bus.emit(Events.TaskUpdated, { id: 'still-connected' })
      await end
      expect(messages).toHaveLength(2)
      expect(messages.join('')).not.toContain(extension.code)
      expect(messages.join('')).toContain(cli.userCode)
    } finally {
      ws?.terminate()
      await app.close()
    }
  })
})
