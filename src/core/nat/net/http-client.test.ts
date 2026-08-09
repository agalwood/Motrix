import { ErrorCode } from '@shared/errors'
import { describe, expect, it } from 'vitest'
import { createMockHttpClient } from './mock-http-client'

describe('MockHttpClient', () => {
  it('records POST calls', async () => {
    const { client, history } = createMockHttpClient()
    history
      .expect({
        method: 'POST',
        host: '192.168.1.1',
        port: 49152,
        path: '/ctl',
      })
      .reply({ statusCode: 200, body: '<ok/>' })

    const r = await client.request({
      method: 'POST',
      host: '192.168.1.1',
      port: 49152,
      path: '/ctl',
      headers: { 'Content-Type': 'text/xml' },
      body: '<soap/>',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.statusCode).toBe(200)
      expect(r.value.body).toBe('<ok/>')
    }
  })

  it('rejects 3xx responses as protocol errors', async () => {
    const { client, history } = createMockHttpClient()
    history
      .expect({
        method: 'GET',
        host: '192.168.1.1',
        port: 49152,
        path: '/desc',
      })
      .reply({ statusCode: 302, headers: { location: 'http://evil.com/x' } })

    const r = await client.request({
      method: 'GET',
      host: '192.168.1.1',
      port: 49152,
      path: '/desc',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatSecurityViolation)
  })

  it('supports abort', { timeout: 10000 }, async () => {
    const { client, history } = createMockHttpClient()
    history
      .expect({
        method: 'GET',
        host: '192.168.1.1',
        port: 49152,
        path: '/desc',
      })
      .delay(5000)
      .reply({ statusCode: 200, body: 'ok' })

    const abort = new AbortController()
    const reqP = client.request({
      method: 'GET',
      host: '192.168.1.1',
      port: 49152,
      path: '/desc',
      signal: abort.signal,
    })
    abort.abort()
    const r = await reqP
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatTimeout)
  })

  it('responds to mid-delay abort promptly', async () => {
    const { client, history } = createMockHttpClient()
    history
      .expect({ method: 'GET', host: '192.168.1.1', port: 49152, path: '/d' })
      .delay(5000)
      .reply({ statusCode: 200, body: 'ok' })

    const abort = new AbortController()
    const start = Date.now()
    const reqP = client.request({
      method: 'GET',
      host: '192.168.1.1',
      port: 49152,
      path: '/d',
      signal: abort.signal,
    })
    setTimeout(() => abort.abort(), 50)
    const r = await reqP
    const elapsed = Date.now() - start

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(ErrorCode.NatTimeout)
    expect(elapsed).toBeLessThan(1000) // should NOT wait the full 5s
  })
})
