import type { AddressInfo } from 'node:net'
import { EventBus } from '@core/events/event-bus'
import { Events } from '@shared/protocol/events'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createApp } from './app'

const TOKEN = 'ws-machine-owner-token'

describe('/rpc/events WebSocket auth', () => {
  let app: FastifyInstance
  let bus: EventBus
  let port: number

  beforeEach(async () => {
    bus = new EventBus()
    app = await createApp({
      eventBus: bus,
      operatorAuth: {
        operatorToken: TOKEN,
        publicUrl: 'https://motrix.example/operator',
      },
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    port = (app.server.address() as AddressInfo).port
  })
  afterEach(async () => {
    await app.close()
  })

  function connect(headers: Record<string, string> = {}): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc/events`, { headers })
      ws.once('open', () => resolve(ws))
      ws.once('unexpected-response', (_req, res) =>
        reject(new Error(`http ${res.statusCode}`))
      )
      ws.once('error', reject)
    })
  }

  async function cookie(): Promise<string> {
    const login = await app.inject({
      method: 'POST',
      url: '/rpc/auth/login',
      payload: { token: TOKEN },
    })
    return (login.headers['set-cookie'] as string).split(';')[0]
  }

  it('rejects an anonymous upgrade', async () => {
    await expect(connect()).rejects.toThrow()
  })

  it('accepts an upgrade carrying the operator cookie and streams events', async () => {
    const ws = await connect({
      cookie: await cookie(),
      origin: 'https://motrix.example',
    })
    const frame = new Promise<unknown>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data))))
    })
    bus.emit(Events.TaskUpdated, { id: 't1' })
    expect(await frame).toEqual({
      channel: Events.TaskUpdated,
      args: [{ id: 't1' }],
    })
    ws.close()
  })

  it.each([
    ['missing Origin', {}],
    ['wrong origin', { origin: 'https://evil.example' }],
    ['wrong scheme', { origin: 'http://motrix.example' }],
  ])('rejects a cookie upgrade with %s', async (_label, headers) => {
    await expect(
      connect({ cookie: await cookie(), ...headers })
    ).rejects.toThrow('http 403')
  })

  it('accepts an upgrade with a Bearer operator token (host script)', async () => {
    const ws = await connect({ authorization: `Bearer ${TOKEN}` })
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })
})
