import { Commands } from '@shared/protocol/commands'
import { describe, expect, it } from 'vitest'
import { createApp, RPC_BODY_LIMIT_BYTES } from './app'
import { ServiceUnavailableError } from './service-unavailable-error'

describe('createApp', () => {
  it('responds to GET /healthz', async () => {
    const app = await createApp()
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await app.close()
  })

  it('returns 503 when the runtime health callback is not ready', async () => {
    const app = await createApp({
      healthCheck: () => ({
        ok: false,
        status: 'degraded',
        engine: { state: 'failed' },
      }),
    })
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({
      ok: false,
      status: 'degraded',
      engine: { state: 'failed' },
    })
    await app.close()
  })

  it('maps a registered but unavailable service handler to 503', async () => {
    const app = await createApp({
      bridgeQueryHandlers: {
        'bridge:getStatus': async () => {
          throw new ServiceUnavailableError('Bridge is unavailable')
        },
      },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/rpc/query/bridge:getStatus',
      payload: { args: [] },
    })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ error: 'Bridge is unavailable' })
    await app.close()
  })

  it('accepts RPC bodies above Fastify default and rejects bodies above 2 MiB', async () => {
    const app = await createApp({
      commandHandlers: {
        [Commands.CreateTask]: async (value: string) => value.length,
      },
    })
    const accepted = await app.inject({
      method: 'POST',
      url: `/rpc/command/${Commands.CreateTask}`,
      payload: { args: ['x'.repeat(1024 * 1024)] },
    })
    const rejected = await app.inject({
      method: 'POST',
      url: `/rpc/command/${Commands.CreateTask}`,
      payload: { args: ['x'.repeat(RPC_BODY_LIMIT_BYTES)] },
    })

    expect(accepted.statusCode).toBe(200)
    expect(accepted.json()).toBe(1024 * 1024)
    expect(rejected.statusCode).toBe(413)
    await app.close()
  })
})
