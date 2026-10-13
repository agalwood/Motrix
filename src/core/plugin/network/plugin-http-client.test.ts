// @vitest-environment node
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import {
  type AddressInfo,
  connect,
  createServer as createSocksServer,
  type Server,
  type Socket,
} from 'node:net'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { proxySettingsSchema } from '@shared/schemas/proxy-settings'
import type { ProxySettings } from '@shared/types/settings'
import { TEST_TLS_CERT, TEST_TLS_KEY } from '@test-utils/plugin-test-tls'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginHttpClient } from './plugin-http-client'

const servers: Server[] = []
const sockets = new Set<Socket>()
const clients: PluginHttpClient[] = []
const originalCAs = getCACertificates()

async function listen(server: Server): Promise<number> {
  servers.push(server)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return (server.address() as AddressInfo).port
}

function client(settings: ProxySettings) {
  const instance = new PluginHttpClient(() => settings)
  clients.push(instance)
  return instance
}

async function proxy(secure = false) {
  const requests: string[] = []
  const credentials: (string | undefined)[] = []
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    requests.push(req.url ?? '')
    credentials.push(req.headers['proxy-authorization'])
    if (req.url?.endsWith('/redirect')) {
      res.writeHead(302, { location: 'http://cdn.invalid/package' }).end()
    } else res.end('proxied')
  }
  const server = secure
    ? createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, handler)
    : createServer(handler)
  server.on('connect', (req, socket, head) => {
    requests.push(req.url ?? '')
    credentials.push(req.headers['proxy-authorization'])
    const target = new URL(`http://${req.url}`)
    const upstream = connect(Number(target.port), target.hostname, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    sockets.add(upstream)
    upstream.once('close', () => sockets.delete(upstream))
    upstream.on('error', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
  })
  const port = await listen(server)
  return {
    requests,
    credentials,
    port,
    settings: proxySettingsSchema.parse({
      enabled: true,
      protocol: secure ? 'https' : 'http',
      host: '127.0.0.1',
      port,
      scopes: { plugins: true },
    }),
  }
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(clients.splice(0).map((value) => value.close()))
  for (const socket of sockets) socket.destroy()
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve()))
      )
  )
  setDefaultCACertificates(originalCAs)
  vi.unstubAllEnvs()
})

describe('plugin HTTP routing', () => {
  it('uses only the plugins scope, authenticates, and follows CDN redirects through the proxy', async () => {
    const fixture = await proxy()
    fixture.settings.user = 'test user'
    fixture.settings.password = 'p@ss:word'
    const result = await client(fixture.settings).fetch(
      'http://plugins.invalid/redirect'
    )
    expect(await result.text()).toBe('proxied')
    expect(fixture.requests).toEqual([
      'http://plugins.invalid/redirect',
      'http://cdn.invalid/package',
    ])
    expect(fixture.credentials).toEqual(
      Array(2).fill(
        `Basic ${Buffer.from('test user:p@ss:word').toString('base64')}`
      )
    )
  })

  it.each([false, true])(
    'tunnels HTTPS and preserves conditional headers (secure proxy: %s)',
    async (secure) => {
      setDefaultCACertificates([...originalCAs, TEST_TLS_CERT])
      const origin = await listen(
        createHttpsServer(
          { key: TEST_TLS_KEY, cert: TEST_TLS_CERT },
          (req, res) => {
            expect(req.headers['proxy-authorization']).toBeUndefined()
            res
              .writeHead(req.headers['if-none-match'] ? 304 : 200, {
                etag: 'registry-v2',
              })
              .end('registry')
          }
        )
      )
      const fixture = await proxy(secure)
      const http = client(fixture.settings)
      const url = `https://127.0.0.1:${origin}/registry`
      const response = await http.fetch(url)
      expect(await response.text()).toBe('registry')
      expect(response.headers.get('etag')).toBe('registry-v2')
      const cached = await http.fetch(url, {
        headers: { 'if-none-match': 'registry-v2' },
      })
      expect(cached.status).toBe(304)
      expect(fixture.requests).toEqual([
        `127.0.0.1:${origin}`,
        `127.0.0.1:${origin}`,
      ])
    }
  )

  it.each(['download', 'updateApp', 'updateTrackers'] as const)(
    'does not use the proxy when only %s is enabled, even with environment proxies',
    async (scope) => {
      const origin = await listen(
        createServer((_req, res) => res.end('direct'))
      )
      const fixture = await proxy()
      fixture.settings.scopes.plugins = false
      fixture.settings.scopes[scope] = true
      vi.stubEnv('HTTP_PROXY', `http://127.0.0.1:${fixture.port}`)
      vi.stubEnv('NODE_USE_ENV_PROXY', '1')
      const response = await client(fixture.settings).fetch(
        `http://127.0.0.1:${origin}/`
      )
      expect(await response.text()).toBe('direct')
      expect(fixture.requests).toEqual([])
    }
  )

  it('re-evaluates bypass for redirects and never sends proxy credentials to the origin', async () => {
    const origin = await listen(
      createServer((req, res) => {
        expect(req.headers['proxy-authorization']).toBeUndefined()
        res.writeHead(302, { location: 'http://cdn.invalid/package' }).end()
      })
    )
    const fixture = await proxy()
    fixture.settings.bypass = ['127.0.0.1']
    const response = await client(fixture.settings).fetch(
      `http://127.0.0.1:${origin}/`
    )
    expect(await response.text()).toBe('proxied')
    expect(fixture.requests).toEqual(['http://cdn.invalid/package'])
  })

  it('uses updated settings for the next request without affecting an active response', async () => {
    let end!: () => void
    const origin = await listen(
      createServer((_req, res) => {
        res.write('first')
        end = () => res.end('-finished')
      })
    )
    const fixture = await proxy()
    const http = client(fixture.settings)
    fixture.settings.enabled = false
    const active = await http.fetch(`http://127.0.0.1:${origin}/`)
    fixture.settings.enabled = true
    expect(
      await (await http.fetch('http://plugins.invalid/package')).text()
    ).toBe('proxied')
    end()
    expect(await active.text()).toBe('first-finished')
  })

  it('uses an owned authenticated SOCKS5 connection when only plugins are enabled', async () => {
    const credentials: string[][] = []
    const origin = await listen(
      createServer((_req, res) => res.end('socks-download'))
    )
    const socks = createSocksServer((socket) => {
      let stage = 0
      let buffer = Buffer.alloc(0)
      const read = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        if (stage === 0) {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return
          buffer = buffer.subarray(2 + buffer[1])
          socket.write(Buffer.from([5, 2]))
          stage = 1
        }
        if (stage === 1) {
          if (buffer.length < 2) return
          const userLength = buffer[1]
          if (buffer.length < 3 + userLength) return
          const passwordLength = buffer[2 + userLength]
          if (buffer.length < 3 + userLength + passwordLength) return
          credentials.push([
            buffer.subarray(2, 2 + userLength).toString(),
            buffer
              .subarray(3 + userLength, 3 + userLength + passwordLength)
              .toString(),
          ])
          buffer = buffer.subarray(3 + userLength + passwordLength)
          socket.write(Buffer.from([1, 0]))
          stage = 2
        }
        if (stage !== 2 || buffer.length < 5) return
        const ipv4 = buffer[3] === 1
        const size = ipv4 ? 10 : 7 + buffer[4]
        if (buffer.length < size) return
        const host = ipv4
          ? [...buffer.subarray(4, 8)].join('.')
          : buffer.subarray(5, 5 + buffer[4]).toString()
        const port = buffer.readUInt16BE(size - 2)
        buffer = buffer.subarray(size)
        stage = 3
        socket.off('data', read)
        const upstream = connect(port, host, () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
          if (buffer.length) upstream.write(buffer)
          upstream.pipe(socket)
          socket.pipe(upstream)
        })
        sockets.add(upstream)
        upstream.once('close', () => sockets.delete(upstream))
        upstream.on('error', () => socket.destroy())
        socket.on('close', () => upstream.destroy())
      }
      socket.on('data', read)
    })
    const port = await listen(socks)
    const http = client(
      proxySettingsSchema.parse({
        enabled: true,
        protocol: 'socks5',
        host: '127.0.0.1',
        port,
        user: 'socks-user',
        password: 'p@ss word',
        scopes: { plugins: true },
      })
    )
    expect(await (await http.fetch(`http://127.0.0.1:${origin}/`)).text()).toBe(
      'socks-download'
    )
    expect(credentials).toEqual([['socks-user', 'p@ss word']])
  })

  it('cancels a stalled SOCKS5 handshake and closes the connection', async () => {
    const port = await listen(createSocksServer(() => undefined))
    const http = client(
      proxySettingsSchema.parse({
        enabled: true,
        protocol: 'socks5',
        host: '127.0.0.1',
        port,
        scopes: { plugins: true },
      })
    )
    const abort = new AbortController()
    const pending = expect(
      http.fetch('http://plugins.invalid/', { signal: abort.signal })
    ).rejects.toMatchObject({ failure: { reason: 'cancelled' } })
    await vi.waitFor(() => expect(sockets.size).toBeGreaterThan(0))
    abort.abort()
    await pending
    await http.close()
    await vi.waitFor(() => expect(sockets.size).toBe(0))
  })

  it('reports rejected SOCKS5 authentication', async () => {
    const port = await listen(
      createSocksServer((socket) => {
        socket.once('data', () => socket.write(Buffer.from([5, 255])))
      })
    )
    const http = client(
      proxySettingsSchema.parse({
        enabled: true,
        protocol: 'socks5',
        host: '127.0.0.1',
        port,
        scopes: { plugins: true },
      })
    )
    await expect(http.fetch('http://plugins.invalid/')).rejects.toMatchObject({
      failure: { reason: 'proxyAuth', route: 'proxy' },
    })
  })

  it('reports an unavailable proxy without falling back or leaking credentials', async () => {
    const fixture = await proxy()
    await new Promise<void>((resolve) => servers[0].close(() => resolve()))
    fixture.settings.user = 'private-user'
    fixture.settings.password = 'private-password'
    await expect(
      client(fixture.settings).fetch(
        'http://plugins.invalid/package?token=secret'
      )
    ).rejects.toMatchObject({
      failure: {
        route: 'proxy',
        reason: 'proxyConnect',
        targetHost: 'plugins.invalid',
        proxyEndpoint: `127.0.0.1:${fixture.port}`,
      },
    })
    try {
      await client(fixture.settings).fetch(
        'http://plugins.invalid/?token=secret'
      )
    } catch (error) {
      expect(JSON.stringify(error)).not.toMatch(
        /private-user|private-password|token=secret/
      )
    }
  })

  it('reports authentication and HTTP status failures', async () => {
    const port = await listen(
      createServer((_req, res) => res.writeHead(407).end())
    )
    const settings = proxySettingsSchema.parse({
      enabled: true,
      host: '127.0.0.1',
      port,
      scopes: { plugins: true },
    })
    await expect(
      client(settings).fetch('http://plugins.invalid/')
    ).rejects.toMatchObject({ failure: { reason: 'proxyAuth' } })
    const origin = await listen(
      createServer((_req, res) => res.writeHead(503).end())
    )
    settings.enabled = false
    await expect(
      client(settings).fetch(`http://127.0.0.1:${origin}/`)
    ).rejects.toMatchObject({ failure: { reason: 'http', status: 503 } })
  })

  it('does not follow a security-policy redirect', async () => {
    const fixture = await proxy()
    await expect(
      client(fixture.settings).fetch('http://plugins.invalid/redirect', {
        redirect: 'error',
      })
    ).rejects.toMatchObject({ failure: { reason: 'network' } })
    expect(fixture.requests).toHaveLength(1)
  })

  it('aborts stalled headers and body reads and drains them on shutdown', async () => {
    const origin = await listen(
      createServer((req, res) => {
        if (req.url === '/body') res.write('partial')
      })
    )
    const http = client(proxySettingsSchema.parse({}))
    const response = await http.fetch(`http://127.0.0.1:${origin}/body`)
    const body = expect(response.text()).rejects.toMatchObject({
      failure: { reason: 'cancelled' },
    })
    const header = expect(
      http.fetch(`http://127.0.0.1:${origin}/headers`)
    ).rejects.toMatchObject({ failure: { reason: 'cancelled' } })
    await http.close()
    await Promise.all([body, header])
  })

  it('retains the deadline until a slow response body ends', async () => {
    const origin = await listen(
      createServer((_req, res) => res.write('partial'))
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const response = await client(proxySettingsSchema.parse({})).fetch(
      `http://127.0.0.1:${origin}/`
    )
    const pending = expect(response.text()).rejects.toMatchObject({
      failure: { reason: 'timeout' },
    })
    await vi.advanceTimersByTimeAsync(60_000)
    await pending
  })
})
