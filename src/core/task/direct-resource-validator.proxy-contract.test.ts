// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const undiciMock = vi.hoisted(() => {
  const agents: Array<{
    kind: 'direct' | 'http' | 'socks5'
    options: unknown
    destroy: ReturnType<typeof vi.fn>
  }> = []

  class Agent {
    readonly kind = 'direct' as const
    readonly options = undefined
    readonly destroy = vi.fn(async () => undefined)

    constructor() {
      agents.push(this)
    }
  }

  class ProxyAgent {
    readonly kind = 'http' as const
    readonly destroy = vi.fn(async () => undefined)

    constructor(readonly options: unknown) {
      agents.push(this)
    }
  }

  class Socks5ProxyAgent {
    readonly kind = 'socks5' as const
    readonly destroy = vi.fn(async () => undefined)

    constructor(
      readonly options: URL,
      readonly config?: unknown
    ) {
      agents.push(this)
    }
  }

  const connector = vi.fn()

  return {
    agents,
    fetch: vi.fn(),
    Agent,
    ProxyAgent,
    Socks5ProxyAgent,
    connector,
    buildConnector: vi.fn(() => connector),
  }
})

vi.mock('undici', () => ({
  fetch: undiciMock.fetch,
  request: undiciMock.fetch,
  Agent: undiciMock.Agent,
  ProxyAgent: undiciMock.ProxyAgent,
  Socks5ProxyAgent: undiciMock.Socks5ProxyAgent,
  buildConnector: undiciMock.buildConnector,
}))

import { DirectResourceValidatorService } from './direct-resource-validator'

describe('DirectResourceValidatorService proxy client contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    undiciMock.agents.length = 0
    undiciMock.connector.mockReset()
    undiciMock.buildConnector.mockClear()
    undiciMock.fetch.mockReset()
    undiciMock.fetch.mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          'Content-Disposition': 'attachment; filename="release.zip"',
        },
      })
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('binds an HTTP proxy agent to fetch from the same Undici module', async () => {
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(
        new Error('global fetch must not receive a dispatcher')
      )
    const service = new DirectResourceValidatorService()

    await expect(
      service.probe('https://downloads.example/latest', {
        proxy: 'http://proxy.example:8080',
        noProxy: 'localhost,*.internal',
      })
    ).resolves.toEqual({ filename: 'release.zip', validator: null })

    expect(globalFetch).not.toHaveBeenCalled()
    expect(undiciMock.agents).toHaveLength(2)
    const proxyAgent = undiciMock.agents.find((agent) => agent.kind === 'http')
    expect(proxyAgent).toMatchObject({
      kind: 'http',
      options: 'http://proxy.example:8080/',
    })
    expect(undiciMock.fetch).toHaveBeenCalledOnce()
    expect(undiciMock.fetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ dispatcher: proxyAgent })
    )
    for (const agent of undiciMock.agents) {
      expect(agent.destroy).toHaveBeenCalledOnce()
    }
  })

  it('routes every redirect hop with aria2-compatible bypass semantics', async () => {
    undiciMock.fetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: 'http://mirror.internal/release' },
        })
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: {
            'Content-Disposition': 'attachment; filename="release.zip"',
          },
        })
      )
    const service = new DirectResourceValidatorService()

    await expect(
      service.probe('https://downloads.example/latest', {
        proxy: 'proxy.example:8080',
        noProxy: '.internal',
      })
    ).resolves.toEqual({ filename: 'release.zip', validator: null })

    const proxyAgent = undiciMock.agents.find((agent) => agent.kind === 'http')
    const directAgent = undiciMock.agents.find(
      (agent) => agent.kind === 'direct'
    )
    expect(proxyAgent?.options).toBe('http://proxy.example:8080/')
    expect(undiciMock.fetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ dispatcher: proxyAgent })
    )
    expect(undiciMock.fetch.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ dispatcher: directAgent })
    )
  })

  it('preserves authority case when applying aria2 no-proxy rules', async () => {
    const service = new DirectResourceValidatorService()

    await expect(
      service.probe('http://API.Internal/release', {
        proxy: 'proxy.example:8080',
        noProxy: '.internal',
      })
    ).resolves.toEqual({ filename: 'release.zip', validator: null })

    const proxyAgent = undiciMock.agents.find((agent) => agent.kind === 'http')
    expect(undiciMock.fetch).toHaveBeenCalledWith(
      'http://API.Internal/release',
      expect.objectContaining({ dispatcher: proxyAgent })
    )
  })

  it.each([
    'http://127.1/release',
    'http://%6cocalhost/release',
    'http://localhost:8\t0/release',
    ' http://localhost/release',
  ])(
    'fails closed for a target WHATWG canonicalizes differently: %s',
    async (target) => {
      const service = new DirectResourceValidatorService()

      await expect(
        service.probe(target, { proxy: 'proxy.example:8080' })
      ).resolves.toBeNull()

      expect(undiciMock.agents).toHaveLength(0)
      expect(undiciMock.fetch).not.toHaveBeenCalled()
    }
  )

  it('fails closed for an uppercase initial scheme that aria2 rejects', async () => {
    const service = new DirectResourceValidatorService()

    await expect(
      service.probe('HTTP://LOCALHOST/release', {
        proxy: 'proxy.example:8080',
        noProxy: 'LOCALHOST',
      })
    ).resolves.toBeNull()

    expect(undiciMock.agents).toHaveLength(0)
    expect(undiciMock.fetch).not.toHaveBeenCalled()
  })

  it('fails closed when WHATWG rewrites an encoded-dot initial path', async () => {
    const service = new DirectResourceValidatorService()

    await expect(
      service.probe('http://downloads.example/safe/%2e%2e/private', {
        proxy: 'proxy.example:8080',
      })
    ).resolves.toBeNull()

    expect(undiciMock.agents).toHaveLength(0)
    expect(undiciMock.fetch).not.toHaveBeenCalled()
  })

  it('does not follow an uppercase redirect scheme that aria2 rejects', async () => {
    undiciMock.fetch.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: 'HTTP://LOCALHOST/private' },
      })
    )
    const service = new DirectResourceValidatorService()

    await expect(
      service.probe('https://downloads.example/latest', {
        proxy: 'proxy.example:8080',
        noProxy: 'LOCALHOST',
      })
    ).resolves.toBeNull()

    expect(undiciMock.fetch).toHaveBeenCalledOnce()
    for (const [target] of undiciMock.fetch.mock.calls) {
      expect(target).toBe('https://downloads.example/latest')
    }
  })

  it('rejects a backslash redirect instead of probing WHATWG\u2019s rewritten host', async () => {
    undiciMock.fetch.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: 'http:\\\\127.0.0.1/release' },
      })
    )
    const service = new DirectResourceValidatorService()

    await expect(
      service.probe('https://downloads.example/latest', {
        proxy: 'proxy.example:8080',
      })
    ).resolves.toBeNull()

    expect(undiciMock.fetch).toHaveBeenCalledOnce()
    for (const [target] of undiciMock.fetch.mock.calls) {
      expect(target).toBe('https://downloads.example/latest')
    }
    for (const agent of undiciMock.agents) {
      expect(agent.destroy).toHaveBeenCalledOnce()
    }
  })

  it.each([
    '/safe/%2e%2e/private',
    '?download=private',
    '/safe//private',
    '/safe path/private',
    'http://localhost:8\t0/private',
    '/next^release',
    '/next`release',
    'next{release',
    'next}release',
    "next?q=x'y",
    '/next?',
    '/café',
  ])(
    'does not follow an aria2-divergent redirect reference: %s',
    async (location) => {
      undiciMock.fetch.mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: location } })
      )
      const service = new DirectResourceValidatorService()

      await expect(
        service.probe('https://downloads.example/latest', {
          proxy: 'proxy.example:8080',
        })
      ).resolves.toBeNull()

      expect(undiciMock.fetch).toHaveBeenCalledOnce()
      for (const [target] of undiciMock.fetch.mock.calls) {
        expect(target).toBe('https://downloads.example/latest')
      }
    }
  )

  it.each([304, 305, 306, 309])(
    'does not follow status %i because aria2 does not treat it as a redirect',
    async (status) => {
      undiciMock.fetch.mockResolvedValue(
        new Response(null, {
          status,
          headers: { Location: 'http://localhost/private' },
        })
      )
      const service = new DirectResourceValidatorService()

      await expect(
        service.probe('https://downloads.example/latest', {
          proxy: 'proxy.example:8080',
          noProxy: 'localhost',
        })
      ).resolves.toBeNull()

      expect(undiciMock.fetch).toHaveBeenCalledOnce()
      expect(undiciMock.fetch.mock.calls[0]?.[0]).toBe(
        'https://downloads.example/latest'
      )
    }
  )

  it('uses the direct package dispatcher for a SOCKS5 bypass target', async () => {
    const service = new DirectResourceValidatorService()

    await expect(
      service.probe('http://127.22.33.44/release', {
        proxy: 'socks5://proxy.example:1080',
        noProxy: '127.0.0.0/8',
      })
    ).resolves.toEqual({ filename: 'release.zip', validator: null })

    const directAgent = undiciMock.agents.find(
      (agent) => agent.kind === 'direct'
    )
    expect(undiciMock.fetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ dispatcher: directAgent })
    )
  })

  it('matches aria2 by treating an HTTPS proxy declaration as HTTP', async () => {
    const service = new DirectResourceValidatorService()

    await service.probe('https://downloads.example/latest', {
      proxy: 'https://proxy.example:8443',
    })

    expect(
      undiciMock.agents.find((agent) => agent.kind === 'http')?.options
    ).toBe('http://proxy.example:8443/')
  })

  it('preserves the HTTPS default port when adapting aria2 proxy syntax', async () => {
    const service = new DirectResourceValidatorService()

    await service.probe('https://downloads.example/latest', {
      proxy: 'https://proxy.example',
    })

    expect(
      undiciMock.agents.find((agent) => agent.kind === 'http')?.options
    ).toBe('http://proxy.example:443/')
  })

  it('keeps the metadata GET on the SOCKS5-bound client', async () => {
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(
        new Error('global fetch must not receive a dispatcher')
      )
    undiciMock.fetch.mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: {
          'Content-Disposition': 'attachment; filename="release.zip"',
        },
      })
    )
    const service = new DirectResourceValidatorService()

    await expect(
      service.probe('https://downloads.example/latest', {
        proxy: 'socks5://proxy.example:1080',
      })
    ).resolves.toEqual({ filename: 'release.zip', validator: null })

    expect(globalFetch).not.toHaveBeenCalled()
    expect(undiciMock.agents).toHaveLength(2)
    const proxyAgent = undiciMock.agents.find(
      (agent) => agent.kind === 'socks5'
    )
    expect(proxyAgent).toMatchObject({
      kind: 'socks5',
    })
    expect(String(proxyAgent?.options)).toBe('socks5://proxy.example:1080')
    expect(undiciMock.fetch).toHaveBeenCalledOnce()
    expect(undiciMock.fetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: 'GET',
        dispatcher: proxyAgent,
      })
    )
    for (const agent of undiciMock.agents) {
      expect(agent.destroy).toHaveBeenCalledOnce()
    }
  })

  it('unbrackets an IPv6 SOCKS5 proxy endpoint through the public connector seam', async () => {
    const service = new DirectResourceValidatorService()

    await service.probe('https://downloads.example/latest', {
      proxy: 'socks5://[::1]:1080',
    })

    const socksAgent = undiciMock.agents.find(
      (agent) => agent.kind === 'socks5'
    ) as
      | ((typeof undiciMock.agents)[number] & {
          config?: { connect?: (...args: unknown[]) => unknown }
        })
      | undefined
    const connect = socksAgent?.config?.connect
    expect(connect).toBeTypeOf('function')
    const callback = vi.fn()
    connect?.(
      {
        hostname: '[::1]',
        host: '[::1]',
        protocol: 'http:',
        port: '1080',
      },
      callback
    )
    expect(undiciMock.connector).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: '::1', host: '::1' }),
      expect.any(Function)
    )
    const socket = { destroy: vi.fn(), once: vi.fn() }
    const connectorCallback = undiciMock.connector.mock.calls[0]?.[1] as
      | ((error: Error | null, value: typeof socket | null) => void)
      | undefined
    connectorCallback?.(null, socket)
    expect(socket.destroy).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith(expect.any(Error), null)
  })

  it('fails closed for an IPv6 target that Undici cannot encode over SOCKS5', async () => {
    const service = new DirectResourceValidatorService()

    await expect(
      service.probe('http://[::1]/release', {
        proxy: 'socks5://proxy.example:1080',
      })
    ).resolves.toBeNull()

    expect(undiciMock.fetch).not.toHaveBeenCalled()
    for (const agent of undiciMock.agents) {
      expect(agent.destroy).toHaveBeenCalledOnce()
    }
  })

  it('captures validators through the proxy-bound client', async () => {
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(
        new Error('global fetch must not receive a dispatcher')
      )
    undiciMock.fetch.mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: {
          ETag: '"proxy-release-v1"',
          'Content-Length': '4096',
        },
      })
    )
    const service = new DirectResourceValidatorService(undefined, 100, () => 7)

    await expect(
      service.capture('https://downloads.example/release.zip', {
        proxy: 'http://proxy.example:8080',
      })
    ).resolves.toEqual({
      kind: 'strong-etag',
      value: '"proxy-release-v1"',
      contentLength: 4096,
      capturedAt: 7,
    })

    expect(globalFetch).not.toHaveBeenCalled()
    expect(undiciMock.agents).toHaveLength(2)
    const proxyAgent = undiciMock.agents.find((agent) => agent.kind === 'http')
    expect(undiciMock.fetch).toHaveBeenCalledOnce()
    expect(undiciMock.fetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: 'GET',
        dispatcher: proxyAgent,
      })
    )
    for (const agent of undiciMock.agents) {
      expect(agent.destroy).toHaveBeenCalledOnce()
    }
  })

  it('verifies a Range response through the package proxy client', async () => {
    undiciMock.fetch.mockResolvedValueOnce(
      new Response(null, {
        status: 206,
        headers: {
          ETag: '"proxy-release-v1"',
          'Content-Range': 'bytes 0-0/4096',
        },
      })
    )
    const service = new DirectResourceValidatorService()

    await expect(
      service.verify(
        'https://downloads.example/release.zip',
        {
          kind: 'strong-etag',
          value: '"proxy-release-v1"',
          contentLength: 4096,
          capturedAt: 7,
        },
        { proxy: 'http://proxy.example:8080' }
      )
    ).resolves.toEqual({
      outcome: 'unchanged',
      ifRange: '"proxy-release-v1"',
    })

    const proxyAgent = undiciMock.agents.find((agent) => agent.kind === 'http')
    expect(undiciMock.fetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        dispatcher: proxyAgent,
        method: 'GET',
        headers: expect.objectContaining({ range: 'bytes=0-0' }),
      })
    )
    for (const agent of undiciMock.agents) {
      expect(agent.destroy).toHaveBeenCalledOnce()
    }
  })

  it('destroys the proxy agent when package fetch fails', async () => {
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(
        new Error('global fetch must not receive a dispatcher')
      )
    undiciMock.fetch.mockRejectedValue(new Error('proxy unavailable'))
    const service = new DirectResourceValidatorService()

    await expect(
      service.probe('https://downloads.example/latest', {
        proxy: 'http://proxy.example:8080',
      })
    ).resolves.toBeNull()

    expect(globalFetch).not.toHaveBeenCalled()
    expect(undiciMock.agents).toHaveLength(2)
    const proxyAgent = undiciMock.agents.find((agent) => agent.kind === 'http')
    expect(undiciMock.fetch).toHaveBeenCalledOnce()
    expect(undiciMock.fetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ dispatcher: proxyAgent })
    )
    for (const agent of undiciMock.agents) {
      expect(agent.destroy).toHaveBeenCalledOnce()
    }
  })

  it('uses a package-owned direct dispatcher instead of global fetch', async () => {
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('global fetch must not run'))
    const service = new DirectResourceValidatorService()

    await expect(
      service.probe('https://downloads.example/latest')
    ).resolves.toEqual({ filename: 'release.zip', validator: null })

    expect(globalFetch).not.toHaveBeenCalled()
    expect(undiciMock.agents).toHaveLength(1)
    const directAgent = undiciMock.agents[0]
    expect(directAgent?.kind).toBe('direct')
    expect(undiciMock.fetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ dispatcher: directAgent, method: 'GET' })
    )
    expect(directAgent?.destroy).toHaveBeenCalledOnce()
  })
})
