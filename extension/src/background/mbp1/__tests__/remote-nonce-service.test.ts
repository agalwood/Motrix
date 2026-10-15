import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRemoteBackendAuthority } from '@/background/mbp1/backend-authority'
import {
  type BridgeRoute,
  deriveRemoteBridgeRoute,
} from '@/background/mbp1/bridge-route'
import {
  type CompatibleRemoteDiscovery,
  REMOTE_NONCE_CAPABILITY_TTL_MS,
  REMOTE_NONCE_MAX_BODY_BYTES,
  type RemoteDiscoveryResult,
  RemoteDiscoveryService,
} from '@/background/mbp1/remote-discovery-service'

const INSTANCE_ID = '95b44a14-d746-49f0-9c50-a5d27288a47b'
const NONCE = 'AQIDBAUGBwgJCgsMDQ4PEA'

interface RequestRecord {
  url: string
  init: RequestInit
}

type Responder = (
  url: string,
  init: RequestInit
) => Response | Promise<Response>

interface HarnessOptions {
  discovery?: Responder
  nonce?: Responder
  service?: ConstructorParameters<typeof RemoteDiscoveryService>[0]
}

afterEach(() => {
  vi.useRealTimers()
})

function route(
  wsBase = 'wss://motrix.example',
  endpointId = 'server-a'
): BridgeRoute {
  return deriveRemoteBridgeRoute(
    createRemoteBackendAuthority({ endpointId, wsBase })
  )
}

function discoveryDocument(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    app: 'motrix-bridge',
    apiVersion: 1,
    instanceId: INSTANCE_ID,
    appVersion: '2.0.0-beta.1',
    runtime: 'server',
    extensionPairing: { protocol: 'mbp1', versions: [1] },
    applicationProtocols: { mdxp: ['1.0'] },
    ...overrides,
  }
}

function response(
  body: BodyInit | null,
  url: string,
  init: ResponseInit = {}
): Response {
  const headers = new Headers(init.headers)
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  const result = new Response(body, { ...init, headers })
  Object.defineProperty(result, 'url', { value: url })
  return result
}

function jsonResponse(
  body: unknown,
  url: string,
  init: ResponseInit = {}
): Response {
  return response(JSON.stringify(body), url, init)
}

function defaultDiscovery(url: string): Response {
  return jsonResponse(discoveryDocument(), url)
}

function defaultNonce(url: string, init: ResponseInit = {}): Response {
  return jsonResponse({ nonce: NONCE, ttlSeconds: 60 }, url, init)
}

function makeHarness(options: HarnessOptions = {}): {
  service: RemoteDiscoveryService
  requests: RequestRecord[]
  fetchImpl: ReturnType<typeof vi.fn>
} {
  const requests: RequestRecord[] = []
  const discovery = options.discovery ?? defaultDiscovery
  const nonce = options.nonce ?? defaultNonce
  const fetchImpl = vi.fn(async (input: string | URL | Request, init = {}) => {
    const url = String(input)
    requests.push({ url, init })
    if (new URL(url).pathname.endsWith('/discovery')) {
      return discovery(url, init)
    }
    if (new URL(url).pathname.endsWith('/nonce')) {
      return nonce(url, init)
    }
    throw new Error('unexpected remote bridge route')
  })
  return {
    service: new RemoteDiscoveryService({
      ...options.service,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
    requests,
    fetchImpl,
  }
}

async function discoverCompatible(
  service: RemoteDiscoveryService,
  bridgeRoute = route()
): Promise<CompatibleRemoteDiscovery> {
  const result = await service.discover(bridgeRoute)
  if (result.status !== 'compatible') {
    throw new Error(`expected compatible discovery, got ${result.status}`)
  }
  return result
}

function asCompatible(
  result: RemoteDiscoveryResult | Record<string, unknown>
): CompatibleRemoteDiscovery {
  return result as unknown as CompatibleRemoteDiscovery
}

describe('RemoteDiscoveryService remote nonce capability', () => {
  it('never obtains a nonce during explicit discovery alone', async () => {
    const { service, requests } = makeHarness()

    const result = await service.discover(route())

    expect(result.status).toBe('compatible')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: 'https://motrix.example/discovery',
      init: { method: 'GET' },
    })
  })

  it('consumes the compatible discovery capability with one exact POST', async () => {
    const { service, requests } = makeHarness()
    const discovery = await discoverCompatible(service)

    const result = await service.requestNonce(discovery)

    expect(result).toEqual({
      status: 'ready',
      nonce: NONCE,
      ttlSeconds: 60,
    })
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual({
      url: 'https://motrix.example/nonce',
      init: {
        method: 'POST',
        headers: { 'X-Motrix-Bridge': '1' },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: expect.any(AbortSignal),
      },
    })
    expect(Object.hasOwn(requests[1]?.init ?? {}, 'body')).toBe(false)
    expect([...new Headers(requests[1]?.init.headers).entries()]).toEqual([
      ['x-motrix-bridge', '1'],
    ])
  })

  it('preserves the exact canonical reverse-proxy prefix and authority', async () => {
    const { service, requests } = makeHarness()
    const bridgeRoute = route(
      'wss://MOTRIX.example:8443/prefix/bridge///',
      'remote-profile-7'
    )
    const discovery = await discoverCompatible(service, bridgeRoute)

    await service.requestNonce(discovery)

    expect(requests.map(({ url }) => url)).toEqual([
      'https://motrix.example:8443/prefix/bridge/discovery',
      'https://motrix.example:8443/prefix/bridge/nonce',
    ])
    expect(discovery.authority.endpointId).toBe('remote-profile-7')
  })

  it('sends no body, cookie, bearer, pair token, or identity query', async () => {
    const { service, requests } = makeHarness()
    const discovery = await discoverCompatible(service)

    await service.requestNonce(discovery)

    const request = requests[1]
    expect(request?.url).not.toContain('?')
    expect(request?.url).not.toContain('token')
    expect(request?.init.credentials).toBe('omit')
    expect(request?.init).not.toHaveProperty('body')
    const headers = new Headers(request?.init.headers)
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('cookie')).toBe(false)
    expect(headers.has('x-motrix-token')).toBe(false)
  })

  it('rejects a structurally forged compatible result before fetch', async () => {
    const { service, requests } = makeHarness()
    const forged = asCompatible({
      status: 'compatible',
      authority: route().authority,
      untrustedDocument: discoveryDocument(),
    })

    expect(await service.requestNonce(forged)).toEqual({
      status: 'unavailable',
      reason: 'remotePairingUnavailable',
      detail: 'invalidDiscoveryCapability',
    })
    expect(requests).toHaveLength(0)
  })

  it('rejects a spread copy even when it copied the private symbol brand', async () => {
    const { service, requests } = makeHarness()
    const discovery = await discoverCompatible(service)
    const copied = { ...discovery } as CompatibleRemoteDiscovery

    expect(await service.requestNonce(copied)).toMatchObject({
      status: 'unavailable',
      detail: 'invalidDiscoveryCapability',
    })
    expect(requests).toHaveLength(1)
  })

  it('rejects a serialized/deserialized compatible result', async () => {
    const { service, requests } = makeHarness()
    const discovery = await discoverCompatible(service)
    const restored = JSON.parse(
      JSON.stringify(discovery)
    ) as CompatibleRemoteDiscovery

    expect(await service.requestNonce(restored)).toMatchObject({
      status: 'unavailable',
      detail: 'invalidDiscoveryCapability',
    })
    expect(requests).toHaveLength(1)
  })

  it('rejects an incompatible discovery result before nonce fetch', async () => {
    const { service, requests } = makeHarness({
      discovery: (url) =>
        jsonResponse(
          discoveryDocument({
            extensionPairing: { protocol: 'mbp1', versions: [0] },
          }),
          url
        ),
    })
    const result = await service.discover(route())
    expect(result.status).toBe('incompatible')

    expect(await service.requestNonce(asCompatible(result))).toMatchObject({
      status: 'unavailable',
      detail: 'invalidDiscoveryCapability',
    })
    expect(requests).toHaveLength(1)
  })

  it('rejects an unavailable discovery result before nonce fetch', async () => {
    const { service, requests } = makeHarness({
      discovery: (url) => response(null, url, { status: 404 }),
    })
    const result = await service.discover(route())
    expect(result.status).toBe('unavailable')

    expect(await service.requestNonce(asCompatible(result))).toMatchObject({
      status: 'unavailable',
      detail: 'invalidDiscoveryCapability',
    })
    expect(requests).toHaveLength(1)
  })

  it('burns a capability presented to another service instance without POST', async () => {
    const first = makeHarness()
    const second = makeHarness()
    const discovery = await discoverCompatible(first.service)

    expect(await second.service.requestNonce(discovery)).toMatchObject({
      status: 'unavailable',
      detail: 'invalidDiscoveryCapability',
    })
    expect(await first.service.requestNonce(discovery)).toMatchObject({
      status: 'unavailable',
      detail: 'discoveryCapabilityConsumed',
    })
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(0)
  })

  it('allows only one POST when two callers race the same capability', async () => {
    let releaseNonce!: (response: Response) => void
    const { service, requests } = makeHarness({
      nonce: (_url) =>
        new Promise<Response>((resolve) => {
          releaseNonce = (result) => resolve(result)
        }),
    })
    const discovery = await discoverCompatible(service)

    const first = service.requestNonce(discovery)
    const second = service.requestNonce(discovery)
    releaseNonce(defaultNonce('https://motrix.example/nonce'))

    expect(await second).toMatchObject({
      status: 'unavailable',
      detail: 'discoveryCapabilityConsumed',
    })
    expect(await first).toEqual({
      status: 'ready',
      nonce: NONCE,
      ttlSeconds: 60,
    })
    expect(requests.filter(({ url }) => url.endsWith('/nonce'))).toHaveLength(1)
  })

  it('rejects every sequential reuse after success', async () => {
    const { service, requests } = makeHarness()
    const discovery = await discoverCompatible(service)

    expect((await service.requestNonce(discovery)).status).toBe('ready')
    expect(await service.requestNonce(discovery)).toMatchObject({
      status: 'unavailable',
      detail: 'discoveryCapabilityConsumed',
    })
    expect(requests.filter(({ url }) => url.endsWith('/nonce'))).toHaveLength(1)
  })

  it('requires a new discovery after a terminal network failure', async () => {
    let nonceCalls = 0
    const { service, requests } = makeHarness({
      nonce: (url) => {
        nonceCalls += 1
        if (nonceCalls === 1) {
          throw new Error('temporary network failure')
        }
        return defaultNonce(url)
      },
    })
    const firstDiscovery = await discoverCompatible(service)

    expect(await service.requestNonce(firstDiscovery)).toMatchObject({
      status: 'unavailable',
      detail: 'networkError',
    })
    expect(await service.requestNonce(firstDiscovery)).toMatchObject({
      status: 'unavailable',
      detail: 'discoveryCapabilityConsumed',
    })

    const secondDiscovery = await discoverCompatible(service)
    expect((await service.requestNonce(secondDiscovery)).status).toBe('ready')
    expect(requests.filter(({ url }) => url.endsWith('/nonce'))).toHaveLength(2)
  })

  it('expires a capability from discovery time and requires rediscovery', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T00:00:00Z'))
    const { service, requests } = makeHarness()
    const firstDiscovery = await discoverCompatible(service)
    await vi.advanceTimersByTimeAsync(REMOTE_NONCE_CAPABILITY_TTL_MS)

    expect(await service.requestNonce(firstDiscovery)).toMatchObject({
      status: 'unavailable',
      detail: 'discoveryCapabilityExpired',
    })
    expect(await service.requestNonce(firstDiscovery)).toMatchObject({
      status: 'unavailable',
      detail: 'discoveryCapabilityConsumed',
    })
    expect(requests.filter(({ url }) => url.endsWith('/nonce'))).toHaveLength(0)

    const secondDiscovery = await discoverCompatible(service)
    expect((await service.requestNonce(secondDiscovery)).status).toBe('ready')
  })

  it('burns a capability when the caller signal was already aborted', async () => {
    const { service, requests } = makeHarness()
    const discovery = await discoverCompatible(service)
    const controller = new AbortController()
    controller.abort()

    expect(
      await service.requestNonce(discovery, { signal: controller.signal })
    ).toMatchObject({
      status: 'unavailable',
      detail: 'requestAborted',
    })
    expect(await service.requestNonce(discovery)).toMatchObject({
      status: 'unavailable',
      detail: 'discoveryCapabilityConsumed',
    })
    expect(requests.filter(({ url }) => url.endsWith('/nonce'))).toHaveLength(0)
  })
})

describe('RemoteDiscoveryService nonce transport and DTO', () => {
  it.each([400, 401, 403, 404, 500, 502, 503])(
    'maps HTTP %i to remotePairingUnavailable without parsing its body',
    async (status) => {
      const { service } = makeHarness({
        nonce: (url) =>
          jsonResponse({ nonce: NONCE, ttlSeconds: 60 }, url, { status }),
      })
      const discovery = await discoverCompatible(service)

      expect(await service.requestNonce(discovery)).toEqual({
        status: 'unavailable',
        reason: 'remotePairingUnavailable',
        detail: 'httpStatus',
        httpStatus: status,
      })
    }
  )

  it('maps 429 and a bounded Retry-After to pairingRateLimited', async () => {
    const { service } = makeHarness({
      nonce: (url) =>
        response('do not parse this body', url, {
          status: 429,
          headers: {
            'content-type': 'text/plain',
            'retry-after': '120',
          },
        }),
    })
    const discovery = await discoverCompatible(service)

    expect(await service.requestNonce(discovery)).toEqual({
      status: 'unavailable',
      reason: 'pairingRateLimited',
      detail: 'rateLimited',
      httpStatus: 429,
      retryAfterSeconds: 120,
    })
  })

  it.each(['-1', '1.5', '999999', 'tomorrow'])(
    'drops unsafe Retry-After value %s',
    async (retryAfter) => {
      const { service } = makeHarness({
        nonce: (url) =>
          response(null, url, {
            status: 429,
            headers: { 'retry-after': retryAfter },
          }),
      })
      const discovery = await discoverCompatible(service)

      expect(await service.requestNonce(discovery)).toEqual({
        status: 'unavailable',
        reason: 'pairingRateLimited',
        detail: 'rateLimited',
        httpStatus: 429,
      })
    }
  )

  it('rejects a response attributed to another authority', async () => {
    const { service } = makeHarness({
      nonce: () => defaultNonce('https://attacker.example/nonce'),
    })
    const discovery = await discoverCompatible(service)

    expect(await service.requestNonce(discovery)).toEqual({
      status: 'unavailable',
      reason: 'remotePairingUnavailable',
      detail: 'unexpectedResponseUrl',
    })
  })

  it.each([
    'https://motrix.example/other/nonce',
    'https://motrix.example/nonce?token=legacy',
  ])('rejects a response attributed to non-exact route %s', async (url) => {
    const { service } = makeHarness({ nonce: () => defaultNonce(url) })
    const discovery = await discoverCompatible(service)

    expect(await service.requestNonce(discovery)).toMatchObject({
      status: 'unavailable',
      detail: 'unexpectedResponseUrl',
    })
  })

  it('defensively rejects a nonconforming fetch that returns a redirect', async () => {
    const { service, requests } = makeHarness({
      nonce: (url, init) => {
        expect(init.redirect).toBe('error')
        return response(null, url, {
          status: 302,
          headers: { location: 'https://attacker.example/nonce' },
        })
      },
    })
    const discovery = await discoverCompatible(service)

    expect(await service.requestNonce(discovery)).toEqual({
      status: 'unavailable',
      reason: 'remotePairingUnavailable',
      detail: 'redirectRejected',
      httpStatus: 302,
    })
    expect(requests.filter(({ url }) => url.endsWith('/nonce'))).toHaveLength(1)
  })

  it('rejects a nonstandard away-and-back nonce result marked redirected', async () => {
    const { service } = makeHarness({
      nonce: (url) => {
        const redirected = defaultNonce(url)
        Object.defineProperty(redirected, 'redirected', { value: true })
        return redirected
      },
    })
    const discovery = await discoverCompatible(service)

    expect(await service.requestNonce(discovery)).toEqual({
      status: 'unavailable',
      reason: 'remotePairingUnavailable',
      detail: 'redirectRejected',
    })
  })

  it('maps the standard redirect:error fetch rejection to generic unavailable', async () => {
    const { service } = makeHarness({
      nonce: (_url, init) => {
        expect(init.redirect).toBe('error')
        throw new TypeError('Failed to fetch because redirect mode is error')
      },
    })
    const discovery = await discoverCompatible(service)

    expect(await service.requestNonce(discovery)).toEqual({
      status: 'unavailable',
      reason: 'remotePairingUnavailable',
      detail: 'networkError',
    })
  })

  it.each([
    'text/plain',
    'text/json',
    'application/problem+json',
    'application/json, text/plain',
    'application/json; charset=iso-8859-1',
  ])('rejects non-protocol content type %s', async (contentType) => {
    const { service } = makeHarness({
      nonce: (url) =>
        defaultNonce(url, { headers: { 'content-type': contentType } }),
    })
    const discovery = await discoverCompatible(service)

    expect(await service.requestNonce(discovery)).toMatchObject({
      status: 'unavailable',
      detail: 'invalidContentType',
    })
  })

  it.each([
    'application/json',
    'Application/JSON',
    'application/json; charset=utf-8',
    'application/json ; charset="UTF-8"',
  ])('accepts strict JSON media type %s', async (contentType) => {
    const { service } = makeHarness({
      nonce: (url) =>
        jsonResponse({ nonce: NONCE, ttlSeconds: 60 }, url, {
          headers: { 'content-type': contentType },
        }),
    })
    const discovery = await discoverCompatible(service)

    expect((await service.requestNonce(discovery)).status).toBe('ready')
  })

  it('stops a streamed nonce body at the strict small decoded-byte cap', async () => {
    let pulls = 0
    const { service } = makeHarness({
      nonce: (url) => {
        const stream = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls += 1
              controller.enqueue(new Uint8Array(3 * 1024))
            },
          },
          { highWaterMark: 0 }
        )
        return response(stream, url)
      },
    })
    const discovery = await discoverCompatible(service)

    expect(await service.requestNonce(discovery)).toEqual({
      status: 'unavailable',
      reason: 'remotePairingUnavailable',
      detail: 'bodyTooLarge',
    })
    expect(pulls).toBeLessThanOrEqual(2)
  })

  it('counts decoded bytes instead of trusting encoded Content-Length', async () => {
    const { service } = makeHarness({
      nonce: (url) =>
        jsonResponse({ nonce: NONCE, ttlSeconds: 60 }, url, {
          headers: {
            'content-encoding': 'gzip',
            'content-length': String(REMOTE_NONCE_MAX_BODY_BYTES + 1),
          },
        }),
    })
    const discovery = await discoverCompatible(service)

    expect((await service.requestNonce(discovery)).status).toBe('ready')
  })

  it.each([
    ['not JSON', '{"nonce":'],
    ['duplicate nonce field', '{"nonce":"one","nonce":"two","ttlSeconds":60}'],
    [
      'escaped duplicate nonce field',
      '{"nonce":"one","\\u006eonce":"two","ttlSeconds":60}',
    ],
    [
      'duplicate ttl field',
      `{"nonce":"${NONCE}","ttlSeconds":60,"ttlSeconds":30}`,
    ],
    ['prototype field', '{"__proto__":{},"nonce":"x","ttlSeconds":60}'],
  ])('rejects raw response with %s', async (_label, body) => {
    const { service } = makeHarness({
      nonce: (url) => response(body, url),
    })
    const discovery = await discoverCompatible(service)

    expect(await service.requestNonce(discovery)).toEqual({
      status: 'unavailable',
      reason: 'remotePairingUnavailable',
      detail: 'malformedNonceResponse',
    })
  })

  it('rejects invalid UTF-8 without reflecting bytes', async () => {
    const { service } = makeHarness({
      nonce: (url) => response(new Uint8Array([0xff]), url),
    })
    const discovery = await discoverCompatible(service)

    expect(await service.requestNonce(discovery)).toMatchObject({
      status: 'unavailable',
      detail: 'malformedNonceResponse',
    })
  })

  it.each([
    ['missing ttlSeconds', { nonce: NONCE }],
    ['missing nonce', { ttlSeconds: 60 }],
    ['extra field', { nonce: NONCE, ttlSeconds: 60, token: 'legacy' }],
    ['empty nonce', { nonce: '', ttlSeconds: 60 }],
    ['wrong-length nonce', { nonce: 'A'.repeat(21), ttlSeconds: 60 }],
    [
      'non-canonical base64url tail bits',
      { nonce: `${'A'.repeat(21)}B`, ttlSeconds: 60 },
    ],
    ['padded nonce', { nonce: `${NONCE}=`, ttlSeconds: 60 }],
    [
      'standard-base64 nonce',
      { nonce: `${NONCE.slice(0, -1)}+`, ttlSeconds: 60 },
    ],
    ['oversized nonce', { nonce: 'a'.repeat(513), ttlSeconds: 60 }],
    ['control nonce', { nonce: 'line\nbreak', ttlSeconds: 60 }],
    ['DEL nonce', { nonce: 'delete\u007f', ttlSeconds: 60 }],
    ['non-ASCII nonce', { nonce: '服务器', ttlSeconds: 60 }],
    ['leading-space nonce', { nonce: ` ${NONCE}`, ttlSeconds: 60 }],
    ['trailing-space nonce', { nonce: `${NONCE} `, ttlSeconds: 60 }],
    ['embedded-space nonce', { nonce: 'opaque nonce', ttlSeconds: 60 }],
    ['zero ttlSeconds', { nonce: NONCE, ttlSeconds: 0 }],
    ['negative ttlSeconds', { nonce: NONCE, ttlSeconds: -1 }],
    ['fractional ttlSeconds', { nonce: NONCE, ttlSeconds: 1.5 }],
    ['string ttlSeconds', { nonce: NONCE, ttlSeconds: '60' }],
    ['short ttlSeconds', { nonce: NONCE, ttlSeconds: 1 }],
    ['alternate ttlSeconds', { nonce: NONCE, ttlSeconds: 30 }],
    ['over-protocol ttlSeconds', { nonce: NONCE, ttlSeconds: 61 }],
  ])('rejects exact DTO violation: %s', async (_label, body) => {
    const { service } = makeHarness({
      nonce: (url) => jsonResponse(body, url),
    })
    const discovery = await discoverCompatible(service)

    expect(await service.requestNonce(discovery)).toEqual({
      status: 'unavailable',
      reason: 'remotePairingUnavailable',
      detail: 'malformedNonceResponse',
    })
  })

  it('accepts the exact MBP1 v1 60-second nonce lifetime', async () => {
    const { service } = makeHarness({
      nonce: (url) => jsonResponse({ nonce: NONCE, ttlSeconds: 60 }, url),
    })
    const discovery = await discoverCompatible(service)

    expect(await service.requestNonce(discovery)).toEqual({
      status: 'ready',
      nonce: NONCE,
      ttlSeconds: 60,
    })
  })

  it('does not reflect a secret-bearing transport error', async () => {
    const { service } = makeHarness({
      nonce: () => {
        throw new Error('token=secret nonce=do-not-reflect')
      },
    })
    const discovery = await discoverCompatible(service)

    const result = await service.requestNonce(discovery)

    expect(result).toEqual({
      status: 'unavailable',
      reason: 'remotePairingUnavailable',
      detail: 'networkError',
    })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('do-not-reflect')
  })
})

describe('RemoteDiscoveryService nonce timeout and bounds', () => {
  it('times out while fetch is pending and aborts the request', async () => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | undefined
    const { service } = makeHarness({
      service: { timeoutMs: 50 },
      nonce: (_url, init) => {
        requestSignal = init.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
      },
    })
    const discovery = await discoverCompatible(service)

    const pending = service.requestNonce(discovery)
    await vi.advanceTimersByTimeAsync(50)

    expect(await pending).toEqual({
      status: 'unavailable',
      reason: 'remotePairingUnavailable',
      detail: 'requestTimedOut',
    })
    expect(requestSignal?.aborted).toBe(true)
  })

  it('enforces the headers deadline when nonce fetch ignores AbortSignal forever', async () => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | undefined
    const { service } = makeHarness({
      service: { timeoutMs: 50 },
      nonce: (_url, init) => {
        requestSignal = init.signal ?? undefined
        return new Promise<Response>(() => undefined)
      },
    })
    const discovery = await discoverCompatible(service)

    const pending = service.requestNonce(discovery)
    await vi.advanceTimersByTimeAsync(50)

    await expect(pending).resolves.toMatchObject({
      status: 'unavailable',
      detail: 'requestTimedOut',
    })
    expect(requestSignal?.aborted).toBe(true)
  })

  it('times out a stalled body even when cancellation never settles', async () => {
    vi.useFakeTimers()
    let cancelled = false
    const { service } = makeHarness({
      service: { timeoutMs: 50 },
      nonce: (url) =>
        response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true
              return new Promise<void>(() => undefined)
            },
          }),
          url
        ),
    })
    const discovery = await discoverCompatible(service)

    const pending = service.requestNonce(discovery)
    await vi.advanceTimersByTimeAsync(50)

    expect(await pending).toMatchObject({
      status: 'unavailable',
      detail: 'requestTimedOut',
    })
    expect(cancelled).toBe(true)
  })

  it('honors a caller abort while nonce fetch is pending', async () => {
    const controller = new AbortController()
    const { service } = makeHarness({
      nonce: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    })
    const discovery = await discoverCompatible(service)

    const pending = service.requestNonce(discovery, {
      signal: controller.signal,
    })
    controller.abort()

    expect(await pending).toMatchObject({
      status: 'unavailable',
      detail: 'requestAborted',
    })
  })

  it('has no Native Messaging, tabs, candidate sweep, launch, or storage side effect', async () => {
    const { service, requests } = makeHarness()
    const discovery = await discoverCompatible(service)

    await service.requestNonce(discovery)

    expect(requests.map(({ url }) => url)).toEqual([
      'https://motrix.example/discovery',
      'https://motrix.example/nonce',
    ])
    for (const { url } of requests) {
      expect(url).not.toContain('127.0.0.1')
      expect(url).not.toContain('localhost')
      expect(url).not.toContain('motrix://')
    }
  })

  it.each([
    { nonceMaxBodyBytes: 0 },
    { nonceMaxBodyBytes: REMOTE_NONCE_MAX_BODY_BYTES + 1 },
    { nonceMaxBodyBytes: 1.5 },
    { nonceCapabilityTtlMs: 0 },
    { nonceCapabilityTtlMs: 60_001 },
    { nonceCapabilityTtlMs: 1.5 },
  ])('rejects an out-of-policy nonce resource bound %j', (options) => {
    expect(
      () =>
        new RemoteDiscoveryService({
          fetchImpl: vi.fn() as unknown as typeof fetch,
          ...options,
        })
    ).toThrow()
  })
})
