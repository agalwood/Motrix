import { describe, expect, it } from 'vitest'
import { createApp } from '../http/app'
import { registerServerDiagnosticsRoute } from './diagnostics'

describe('server diagnostics route', () => {
  it('requires operator authentication and returns the runtime snapshot', async () => {
    const app = await createApp({
      operatorAuth: { operatorToken: 'operator-secret' },
    })
    registerServerDiagnosticsRoute(app, async () => ({
      health: { ok: true },
      storage: { dataDir: '/data', downloads: ['/downloads'] },
    }))

    expect(
      (await app.inject({ method: 'GET', url: '/api/diagnostics' })).statusCode
    ).toBe(401)
    const response = await app.inject({
      method: 'GET',
      url: '/api/diagnostics',
      headers: { authorization: 'Bearer operator-secret' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      health: { ok: true },
      storage: { dataDir: '/data', downloads: ['/downloads'] },
    })
    await app.close()
  })

  it('returns a clear error when a diagnostic probe fails', async () => {
    const app = await createApp()
    registerServerDiagnosticsRoute(app, () => {
      throw new Error('aria2 probe failed')
    })
    const response = await app.inject({
      method: 'GET',
      url: '/api/diagnostics',
    })
    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({ error: 'aria2 probe failed' })
    await app.close()
  })
})
