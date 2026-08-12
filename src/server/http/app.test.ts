import { describe, expect, it } from 'vitest'
import { createApp } from './app'

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
})
