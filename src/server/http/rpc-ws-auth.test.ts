import type { AddressInfo } from 'node:net'
import { EventBus } from '@core/events/event-bus'
import { Commands } from '@shared/protocol/commands'
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
  let now: number

  beforeEach(async () => {
    now = 1_000
    bus = new EventBus()
    app = await createApp({
      eventBus: bus,
      commandHandlers: {
        [Commands.CreateTask]: async () => ({
          outcome: 'created',
          taskId: 't1',
          gid: 'g1',
        }),
      },
      operatorAuth: {
        operatorToken: TOKEN,
        now: () => now,
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
  it('revokes every socket owned by the logged-out cookie before further broadcasts', async () => {
    const session = await cookie()
    const sockets = await Promise.all([
      connect({ cookie: session, origin: 'https://motrix.example' }),
      connect({ cookie: session, origin: 'https://motrix.example' }),
    ])
    const independent = await connect({
      cookie: await cookie(),
      origin: 'https://motrix.example',
    })
    const bearer = await connect({ authorization: `Bearer ${TOKEN}` })
    const received: string[] = []
    for (const ws of sockets)
      ws.on('message', (data) => received.push(String(data)))
    const closed = sockets.map(
      (ws) => new Promise<number>((resolve) => ws.once('close', resolve))
    )
    await app.inject({
      method: 'POST',
      url: '/rpc/auth/logout',
      headers: { cookie: session },
    })
    const unaffected = [independent, bearer].map(
      (ws) => new Promise<unknown>((resolve) => ws.once('message', resolve))
    )
    bus.emit(Events.TaskUpdated, { id: 'after-logout' })
    expect(await Promise.all(closed)).toEqual([4401, 4401])
    await Promise.all(unaffected)
    expect(received).toEqual([])
    independent.close()
    bearer.close()
  })

  it('does not renew the cookie on broadcasts and suppresses the first expired frame', async () => {
    const ws = await connect({
      cookie: await cookie(),
      origin: 'https://motrix.example',
    })
    now += 6 * 24 * 60 * 60 * 1000
    const first = new Promise<unknown>((resolve) => ws.once('message', resolve))
    bus.emit(Events.TaskUpdated, { id: 'still-valid' })
    await first
    const received: string[] = []
    ws.on('message', (data) => received.push(String(data)))
    const closed = new Promise<number>((resolve) => ws.once('close', resolve))
    now += 24 * 60 * 60 * 1000
    bus.emit(Events.TaskUpdated, { id: 'expired' })
    expect(await closed).toBe(4401)
    expect(received).toEqual([])
  })
  it('diagnoses a mismatched browser origin while HTTP commands remain available', async () => {
    const session = await cookie()
    const origin = 'http://nas.local:8080'
    const response = await app.inject({
      method: 'POST',
      url: `/rpc/command/${encodeURIComponent(Commands.CreateTask)}`,
      headers: { cookie: session, origin, host: 'nas.local:8080' },
      payload: { args: [] },
    })
    expect(response.statusCode).toBe(200)
    const diagnostic = await app.inject({
      method: 'GET',
      url: '/rpc/auth/status',
      headers: { cookie: session, 'x-motrix-web-origin': origin },
    })
    expect(diagnostic.json()).toMatchObject({
      authed: true,
      eventOriginMatches: false,
    })
    await expect(connect({ cookie: session, origin })).rejects.toThrow(
      'http 403'
    )
    const anonymous = await app.inject({
      method: 'GET',
      url: '/rpc/auth/status',
      headers: { 'x-motrix-web-origin': origin },
    })
    expect(anonymous.json()).not.toHaveProperty('eventOriginMatches')
    const matching = await app.inject({
      method: 'GET',
      url: '/rpc/auth/status',
      headers: {
        cookie: session,
        'x-motrix-web-origin': 'https://motrix.example',
      },
    })
    expect(matching.json()).toMatchObject({ eventOriginMatches: true })
  })
})
