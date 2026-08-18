// Tests for the http capability.
//
// Uses an in-process Node http server bound to 127.0.0.1:0 (random port).
// No real network connections are made.

import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HttpCapabilityHost } from './http'
import { CookieJar, ensureCookieJarSchema } from './http-cookies'

// ---------------------------------------------------------------------------
// Test server helpers
// ---------------------------------------------------------------------------

const LARGE_BODY_SIZE = 200 * 1024 // 200 KB

function createTestServer(): Promise<{
  server: http.Server
  baseUrl: string
}> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '/'

      if (url === '/text') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('hello')
        return
      }

      if (url === '/json') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"x":1}')
        return
      }

      if (url === '/bytes') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        res.end(Buffer.from([1, 2, 3]))
        return
      }

      if (url === '/redirect-once') {
        res.writeHead(302, { Location: `${baseUrl}/text` })
        res.end()
        return
      }

      if (url === '/redirect-loop') {
        res.writeHead(302, { Location: `${baseUrl}/redirect-loop` })
        res.end()
        return
      }

      if (url === '/redirect-to-file') {
        res.writeHead(302, { Location: 'file:///etc/hosts' })
        res.end()
        return
      }

      if (url === '/redirect-external') {
        res.writeHead(302, { Location: 'https://elsewhere.example/file' })
        res.end()
        return
      }

      if (url === '/large') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        // Stream in chunks to simulate streaming response.
        const chunk = Buffer.alloc(4096, 'a')
        let written = 0
        const writeChunk = () => {
          if (written >= LARGE_BODY_SIZE) {
            res.end()
            return
          }
          const ok = res.write(chunk)
          written += chunk.byteLength
          if (ok) {
            setImmediate(writeChunk)
          } else {
            res.once('drain', writeChunk)
          }
        }
        writeChunk()
        return
      }

      if (url === '/set-cookie') {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Set-Cookie': 'foo=1; Path=/',
        })
        res.end('ok')
        return
      }

      if (url === '/needs-cookie') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(req.headers.cookie ?? 'no-cookie')
        return
      }

      if (url === '/slow') {
        // Never respond — used for timeout test.
        return
      }

      if (url === '/post-echo') {
        const parts: Buffer[] = []
        req.on('data', (chunk: Buffer) => parts.push(chunk))
        req.on('end', () => {
          const body = Buffer.concat(parts).toString('utf8')
          const ct = req.headers['content-type'] ?? ''
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end(`${ct}|${body}`)
        })
        return
      }

      res.writeHead(404)
      res.end('not found')
    })

    let baseUrl = ''

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${addr.port}`
      resolve({ server, baseUrl })
    })

    server.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('HttpCapabilityHost', () => {
  let server: http.Server
  let baseUrl: string
  let host: HttpCapabilityHost

  beforeEach(async () => {
    const result = await createTestServer()
    server = result.server
    baseUrl = result.baseUrl
    host = new HttpCapabilityHost()
  })

  afterEach(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
  )

  // Test 1: GET text
  it('GET text returns body hello with status 200 and lowercased headers', async () => {
    const resp = await host.get(`${baseUrl}/text`)
    expect(resp.status).toBe(200)
    expect(resp.body).toBe('hello')
    // All header names should be lowercase (spec §4 L1184 + undici normalization).
    for (const h of resp.headers) {
      expect(h.name).toBe(h.name.toLowerCase())
    }
    const contentType = resp.headers.find((h) => h.name === 'content-type')
    expect(contentType?.value).toContain('text/plain')
  })

  // Test 2: GET json with responseType: 'json'
  it("GET json with responseType 'json' returns parsed object", async () => {
    const resp = await host.get<'json'>(`${baseUrl}/json`, {
      responseType: 'json',
    })
    expect(resp.status).toBe(200)
    expect(resp.body).toEqual({ x: 1 })
  })

  // Test 3: GET bytes with responseType: 'bytes'
  it("GET bytes with responseType 'bytes' returns Uint8Array", async () => {
    const resp = await host.get<'bytes'>(`${baseUrl}/bytes`, {
      responseType: 'bytes',
    })
    expect(resp.status).toBe(200)
    expect(resp.body).toBeInstanceOf(Uint8Array)
    expect(Array.from(resp.body as Uint8Array)).toEqual([1, 2, 3])
  })

  // Test 4: Scheme rejection
  it('rejects file:// URLs with plugin.http.scheme_not_allowed', async () => {
    await expect(host.get('file:///etc/passwd')).rejects.toMatchObject({
      code: 'plugin.http.scheme_not_allowed',
    })
  })

  // Test 5: Invalid URL
  it('rejects non-URL strings with plugin.http.invalid_url', async () => {
    await expect(host.get('not a url')).rejects.toMatchObject({
      code: 'plugin.http.invalid_url',
    })
  })

  // Test 6: maxBodyBytes enforced
  it('rejects response exceeding maxBodyBytes with plugin.http.response_too_large', async () => {
    await expect(
      host.get(`${baseUrl}/large`, { maxBodyBytes: 1024 })
    ).rejects.toMatchObject({ code: 'plugin.http.response_too_large' })
  })

  // Test 7: Redirect follow
  it('follows redirect by default and returns final response body', async () => {
    const resp = await host.get(`${baseUrl}/redirect-once`)
    expect(resp.body).toBe('hello')
    expect(resp.status).toBe(200)
  })

  // Test 8: Redirect manual
  it("redirect: 'manual' returns 302 directly without following", async () => {
    const resp = await host.get(`${baseUrl}/redirect-once`, {
      redirect: 'manual',
    })
    expect(resp.status).toBe(302)
  })

  // Test 9: Redirect loop
  it('rejects redirect loop with plugin.http.too_many_redirects', async () => {
    await expect(host.get(`${baseUrl}/redirect-loop`)).rejects.toMatchObject({
      code: 'plugin.http.too_many_redirects',
    })
  })

  it('re-validates scheme on redirect (rejects 3xx to file://)', async () => {
    // The initial scheme check passes (http); the 302 Location is file://.
    // Without per-hop re-validation this would escape the http/https allowlist.
    await expect(host.get(`${baseUrl}/redirect-to-file`)).rejects.toMatchObject(
      { code: 'plugin.http.scheme_not_allowed' }
    )
  })

  it('treats maxBodyBytes: 0 as unset (falls back to the default cap)', async () => {
    // 0 (and NaN, via the unvalidated get/post path) must not become the cap —
    // otherwise every response, even an empty one, fails as "too large".
    const resp = await host.get(`${baseUrl}/text`, { maxBodyBytes: 0 })
    expect(resp.status).toBe(200)
  })

  // Test 10: AbortSignal
  it('aborts mid-request when plugin signal fires', async () => {
    const ctrl = new AbortController()
    const promise = host.get(`${baseUrl}/slow`, { signal: ctrl.signal })
    // Abort after a short delay to ensure request is in-flight.
    setTimeout(() => ctrl.abort(), 20)
    await expect(promise).rejects.toMatchObject({
      code: 'plugin.http.aborted',
    })
  })

  // Test 11: Internal timeout
  it('rejects with plugin.http.timeout when server never responds', async () => {
    await expect(
      host.get(`${baseUrl}/slow`, { timeoutMs: 100 })
    ).rejects.toMatchObject({ code: 'plugin.http.timeout' })
  })

  // Test 12: Cookies jar
  it('captures Set-Cookie and sends Cookie on subsequent requests', async () => {
    const db = new Database(':memory:')
    ensureCookieJarSchema(db)
    const jar = new CookieJar(db, 'test-plugin')
    const cookieHost = new HttpCapabilityHost({ cookieJar: jar })

    // First request — server sets foo=1.
    await cookieHost.get(`${baseUrl}/set-cookie`, { cookies: 'jar' })

    // Verify jar has the cookie.
    const cookies = jar.list()
    expect(cookies.some((c) => c.name === 'foo' && c.value === '1')).toBe(true)

    // Second request — should send Cookie: foo=1; server echoes it.
    const resp = await cookieHost.get(`${baseUrl}/needs-cookie`, {
      cookies: 'jar',
    })
    expect(resp.body).toContain('foo=1')
  })

  // Test 13: POST json body
  it('POST with json body serializes and sets Content-Type', async () => {
    const resp = await host.post(`${baseUrl}/post-echo`, {
      type: 'json',
      data: { hello: 'world' },
    })
    const body = resp.body as string
    expect(body).toContain('application/json')
    expect(body).toContain('{"hello":"world"}')
  })

  // Test 14: Headers lowercased on response
  it('returns all response headers with lowercase keys', async () => {
    const resp = await host.get(`${baseUrl}/json`, { responseType: 'text' })
    for (const h of resp.headers) {
      expect(h.name).toBe(h.name.toLowerCase())
    }
  })
})

// ---------------------------------------------------------------------------
// Host permissions enforcement
// ---------------------------------------------------------------------------

describe('HttpCapabilityHost host permissions', () => {
  let server: http.Server
  let baseUrl: string

  beforeEach(async () => {
    const created = await createTestServer()
    server = created.server
    baseUrl = created.baseUrl
  })

  afterEach(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  )

  it('rejects a URL outside the declared hostPermissions without a request', async () => {
    const host = new HttpCapabilityHost({
      hostPermissions: ['https://allowed.example/*'],
    })
    await expect(host.get(`${baseUrl}/text`)).rejects.toMatchObject({
      code: 'plugin.http.host_not_permitted',
    })
  })

  it('allows a URL matching the declared hostPermissions', async () => {
    const host = new HttpCapabilityHost({
      hostPermissions: ['http://127.0.0.1:*/*'],
    })
    const resp = await host.get(`${baseUrl}/text`)
    expect(resp.body).toBe('hello')
  })

  it('denies every URL when hostPermissions is empty', async () => {
    const host = new HttpCapabilityHost({ hostPermissions: [] })
    await expect(host.get(`${baseUrl}/text`)).rejects.toMatchObject({
      code: 'plugin.http.host_not_permitted',
    })
  })

  it('re-checks hostPermissions on every redirect hop', async () => {
    const host = new HttpCapabilityHost({
      hostPermissions: ['http://127.0.0.1:*/*'],
    })
    await expect(
      host.get(`${baseUrl}/redirect-external`)
    ).rejects.toMatchObject({ code: 'plugin.http.host_not_permitted' })
  })

  it('leaves hosts unrestricted when hostPermissions is not provided', async () => {
    const host = new HttpCapabilityHost()
    const resp = await host.get(`${baseUrl}/text`)
    expect(resp.body).toBe('hello')
  })
})
