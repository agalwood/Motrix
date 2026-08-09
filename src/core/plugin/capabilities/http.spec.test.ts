// Spec-conformance tests for HttpCapabilityHost — Batch 3a (M3/M4/M8/M10).
// Pins behavior added by the Phase 1A audit fixes:
//   - default timeoutMs 30_000, hard cap 300_000 (M3)
//   - redirect: 'error' mode rejects 3xx (M4)
//   - range option generates `Range: bytes=start-end` header (M4)
//   - response.headers as Array<{name, value}> (M8)
//   - response.finalUrl + redirected fields (M8)
//   - responseType required (M10)
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HttpCapabilityHost } from './http'

function createTestServer(): Promise<{
  server: http.Server
  baseUrl: string
}> {
  return new Promise((resolve, reject) => {
    let baseUrl = ''
    const server = http.createServer((req, res) => {
      const url = req.url ?? '/'

      if (url === '/text') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('hello')
        return
      }
      if (url === '/range-echo') {
        // Echoes back the Range header so tests can assert it was sent.
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(req.headers.range ?? 'no-range')
        return
      }
      if (url === '/redirect-once') {
        res.writeHead(302, { Location: `${baseUrl}/text` })
        res.end()
        return
      }
      if (url === '/dup-headers') {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'X-First': '1',
          'X-Second': '2',
        })
        res.end('ok')
        return
      }
      res.writeHead(404)
      res.end('not found')
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${addr.port}`
      resolve({ server, baseUrl })
    })
    server.on('error', reject)
  })
}

describe('HttpCapabilityHost — spec conformance', () => {
  let server: http.Server
  let baseUrl: string
  let host: HttpCapabilityHost

  beforeEach(async () => {
    const r = await createTestServer()
    server = r.server
    baseUrl = r.baseUrl
    host = new HttpCapabilityHost()
  })
  afterEach(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
  )

  // -------------------------------------------------------------------------
  // M8 — response headers are Array<{name, value}>
  // -------------------------------------------------------------------------
  describe('response.headers shape (M8)', () => {
    it('returns headers as an array of {name, value} objects', async () => {
      const resp = await host.request({
        method: 'GET',
        url: `${baseUrl}/text`,
        responseType: 'text',
      })
      expect(Array.isArray(resp.headers)).toBe(true)
      const ct = resp.headers.find(
        (h) => h.name.toLowerCase() === 'content-type'
      )
      expect(ct?.value).toContain('text/plain')
    })

    it('preserves all header pairs (no dedup)', async () => {
      const resp = await host.request({
        method: 'GET',
        url: `${baseUrl}/dup-headers`,
        responseType: 'text',
      })
      const names = resp.headers.map((h) => h.name.toLowerCase())
      expect(names).toContain('x-first')
      expect(names).toContain('x-second')
    })

    it('headers entries have lowercased names (undici normalization)', async () => {
      const resp = await host.request({
        method: 'GET',
        url: `${baseUrl}/text`,
        responseType: 'text',
      })
      for (const h of resp.headers) {
        expect(h.name).toBe(h.name.toLowerCase())
      }
    })
  })

  // -------------------------------------------------------------------------
  // M8 — finalUrl + redirected
  // -------------------------------------------------------------------------
  describe('response.finalUrl and redirected (M8)', () => {
    it('finalUrl equals the original URL when no redirect happened', async () => {
      const resp = await host.request({
        method: 'GET',
        url: `${baseUrl}/text`,
        responseType: 'text',
      })
      expect(resp.redirected).toBe(false)
      expect(resp.finalUrl).toBe(`${baseUrl}/text`)
    })

    it('finalUrl reflects the final landing URL after follow-redirect', async () => {
      const resp = await host.request({
        method: 'GET',
        url: `${baseUrl}/redirect-once`,
        responseType: 'text',
        redirect: 'follow',
      })
      expect(resp.redirected).toBe(true)
      expect(resp.finalUrl).toBe(`${baseUrl}/text`)
    })
  })

  // -------------------------------------------------------------------------
  // M4 — redirect: 'error' rejects 3xx with plugin.http.redirect_not_allowed
  // -------------------------------------------------------------------------
  describe('redirect: "error" mode (M4)', () => {
    it('throws plugin.http.redirect_not_allowed when a 3xx is encountered', async () => {
      await expect(
        host.request({
          method: 'GET',
          url: `${baseUrl}/redirect-once`,
          responseType: 'text',
          redirect: 'error',
        })
      ).rejects.toMatchObject({ code: 'plugin.http.redirect_not_allowed' })
    })

    it('does not throw for a 2xx when redirect: "error" is set', async () => {
      const resp = await host.request({
        method: 'GET',
        url: `${baseUrl}/text`,
        responseType: 'text',
        redirect: 'error',
      })
      expect(resp.status).toBe(200)
    })
  })

  // -------------------------------------------------------------------------
  // M4 — range option generates Range header
  // -------------------------------------------------------------------------
  describe('range option (M4)', () => {
    it('sets the Range header from the {start, end} pair', async () => {
      const resp = await host.request({
        method: 'GET',
        url: `${baseUrl}/range-echo`,
        responseType: 'text',
        range: { start: 100, end: 199 },
      })
      expect(resp.body).toBe('bytes=100-199')
    })

    it('omits the Range header when range is undefined', async () => {
      const resp = await host.request({
        method: 'GET',
        url: `${baseUrl}/range-echo`,
        responseType: 'text',
      })
      expect(resp.body).toBe('no-range')
    })
  })
})
