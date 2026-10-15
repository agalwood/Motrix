import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRemoteBackendAuthority } from '@/background/mbp1/backend-authority'
import {
  type BridgeRoute,
  deriveRemoteBridgeRoute,
} from '@/background/mbp1/bridge-route'
import {
  REMOTE_DISCOVERY_MAX_BODY_BYTES,
  RemoteDiscoveryService,
} from '@/background/mbp1/remote-discovery-service'

const ROOT_DISCOVERY_URL = 'https://motrix.example/discovery'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function route(
  wsBase = 'wss://motrix.example',
  endpointId = 'server-a'
): BridgeRoute {
  return deriveRemoteBridgeRoute(
    createRemoteBackendAuthority({ endpointId, wsBase })
  )
}

function document(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    app: 'motrix-bridge',
    apiVersion: 1,
    instanceId: '95b44a14-d746-49f0-9c50-a5d27288a47b',
    appVersion: '2.0.0-beta.1',
    runtime: 'server',
    extensionPairing: { protocol: 'mbp1', versions: [1] },
    applicationProtocols: { mdxp: ['1.0'] },
    ...overrides,
  }
}

function response(
  body: BodyInit | null,
  init: ResponseInit = {},
  responseUrl = ROOT_DISCOVERY_URL
): Response {
  const headers = new Headers(init.headers)
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  const result = new Response(body, { ...init, headers })
  Object.defineProperty(result, 'url', { value: responseUrl })
  return result
}

function jsonResponse(
  body = document(),
  init: ResponseInit = {},
  responseUrl = ROOT_DISCOVERY_URL
): Response {
  return response(JSON.stringify(body), init, responseUrl)
}

function serviceReturning(
  result: Response | Promise<Response>,
  options: { timeoutMs?: number; maxBodyBytes?: number } = {}
): {
  service: RemoteDiscoveryService
  fetchImpl: ReturnType<typeof vi.fn>
} {
  const fetchImpl = vi.fn(async () => result)
  return {
    service: new RemoteDiscoveryService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...options,
    }),
    fetchImpl,
  }
}

describe('RemoteDiscoveryService', () => {
  it('binds the native fetch receiver for Chromium MV3 service workers', async () => {
    vi.stubGlobal(
      'fetch',
      function receiverSensitiveFetch(this: unknown): Promise<Response> {
        if (this !== globalThis) throw new TypeError('Illegal invocation')
        return Promise.resolve(jsonResponse())
      }
    )
    const service = new RemoteDiscoveryService()

    await expect(service.discover(route())).resolves.toMatchObject({
      status: 'compatible',
    })
  })

  it('fetches exactly the issued root authority and returns an explicitly untrusted hint', async () => {
    const { service, fetchImpl } = serviceReturning(jsonResponse())

    const result = await service.discover(route())

    expect(result).toMatchObject({
      status: 'compatible',
      authority: {
        kind: 'remote',
        endpointId: 'server-a',
        canonicalWsBase: 'wss://motrix.example',
      },
      untrustedDocument: {
        app: 'motrix-bridge',
        apiVersion: 1,
        instanceId: '95b44a14-d746-49f0-9c50-a5d27288a47b',
        appVersion: '2.0.0-beta.1',
        runtime: 'server',
        extensionPairing: { protocol: 'mbp1', versions: [1] },
        applicationProtocols: { mdxp: ['1.0'] },
      },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith(ROOT_DISCOVERY_URL, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: expect.any(AbortSignal),
    })
  })

  it('preserves a canonical reverse-proxy base path without probing any alternative', async () => {
    const discoveryUrl = 'https://motrix.example:8443/prefix/bridge/discovery'
    const { service, fetchImpl } = serviceReturning(
      jsonResponse(document(), {}, discoveryUrl)
    )

    const result = await service.discover(
      route('wss://MOTRIX.example:8443/prefix/bridge///')
    )

    expect(result.status).toBe('compatible')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(discoveryUrl)
  })

  it('never sends a token, cookie, authorization header, or custom identity header', async () => {
    const { service, fetchImpl } = serviceReturning(jsonResponse())

    await service.discover(route())

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).not.toContain('token')
    expect(init.credentials).toBe('omit')
    expect(init.headers).toBeUndefined()
  })

  it('does not touch Native Messaging, tabs, local launch, or candidate ports', async () => {
    const requestedUrls: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requestedUrls.push(String(input))
      return jsonResponse()
    })
    const service = new RemoteDiscoveryService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await service.discover(route())

    expect(requestedUrls).toEqual([ROOT_DISCOVERY_URL])
    expect(requestedUrls[0]).not.toContain('127.0.0.1')
    expect(requestedUrls[0]).not.toContain('localhost')
  })

  it('binds endpointId to the issued authority, not to response data', async () => {
    const { service } = serviceReturning(jsonResponse())

    const result = await service.discover(
      route('wss://motrix.example', 'locally-generated-id')
    )

    expect(result).toMatchObject({
      status: 'compatible',
      authority: { endpointId: 'locally-generated-id' },
    })
    expect(result).not.toHaveProperty('untrustedDocument.endpointId')
  })

  it('rejects post-issuance route substitution before fetch', async () => {
    const issued = route()
    const forged = {
      ...issued,
      discoveryUrl: 'https://169.254.169.254/latest/meta-data',
    } satisfies BridgeRoute
    const { service, fetchImpl } = serviceReturning(jsonResponse())

    await expect(service.discover(forged)).rejects.toThrow(
      'BridgeRoute must be created by deriveRemoteBridgeRoute'
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a persisted/deserialized route before fetch', async () => {
    const restored = JSON.parse(JSON.stringify(route())) as BridgeRoute
    const { service, fetchImpl } = serviceReturning(jsonResponse())

    await expect(service.discover(restored)).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['another authority', 'https://other.example/discovery'],
    ['another path', 'https://motrix.example/admin/discovery'],
    ['a query-bearing URL', 'https://motrix.example/discovery?next=1'],
  ])('rejects a successful response attributed to %s', async (_label, url) => {
    const { service } = serviceReturning(jsonResponse(document(), {}, url))

    await expect(service.discover(route())).resolves.toEqual({
      status: 'unavailable',
      reason: 'remoteDiscoveryUnavailable',
      detail: 'unexpectedResponseUrl',
    })
  })

  it('defensively rejects a nonconforming fetch implementation that returns a 3xx response', async () => {
    const fetchImpl = vi.fn(
      async (_input: unknown, init?: RequestInit): Promise<Response> => {
        expect(init?.redirect).toBe('error')
        return response(null, {
          status: 302,
          headers: {
            location: 'https://attacker.example/discovery',
            'content-type': 'text/plain',
          },
        })
      }
    )
    const service = new RemoteDiscoveryService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(await service.discover(route())).toEqual({
      status: 'unavailable',
      reason: 'remoteDiscoveryUnavailable',
      detail: 'redirectRejected',
      httpStatus: 302,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects a nonstandard away-and-back fetch result marked redirected', async () => {
    const redirected = jsonResponse()
    Object.defineProperty(redirected, 'redirected', { value: true })
    const { service } = serviceReturning(redirected)

    expect(await service.discover(route())).toEqual({
      status: 'unavailable',
      reason: 'remoteDiscoveryUnavailable',
      detail: 'redirectRejected',
    })
  })

  it('maps the browser redirect:error rejection to generic unavailable', async () => {
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe('error')
      throw new TypeError('Failed to fetch because redirect mode is error')
    })
    const service = new RemoteDiscoveryService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(await service.discover(route())).toEqual({
      status: 'unavailable',
      reason: 'remoteDiscoveryUnavailable',
      detail: 'networkError',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([201, 204, 206, 400, 401, 403, 404, 500, 503])(
    'maps HTTP %i to unavailable, never to an upgrade verdict',
    async (status) => {
      const { service } = serviceReturning(
        response(
          status === 204
            ? null
            : JSON.stringify(
                document({
                  apiVersion: 0,
                  extensionPairing: { protocol: 'mbp1', versions: [0] },
                  applicationProtocols: { mdxp: ['0.9'] },
                })
              ),
          { status, headers: { 'content-type': 'application/json' } }
        )
      )

      expect(await service.discover(route())).toEqual({
        status: 'unavailable',
        reason: 'remoteDiscoveryUnavailable',
        detail: 'httpStatus',
        httpStatus: status,
      })
    }
  )

  it('returns a bounded rate-limit diagnostic without parsing the body', async () => {
    const { service } = serviceReturning(
      response('not JSON and must not be surfaced', {
        status: 429,
        headers: {
          'content-type': 'text/plain',
          'retry-after': '120',
        },
      })
    )

    expect(await service.discover(route())).toEqual({
      status: 'unavailable',
      reason: 'remoteDiscoveryUnavailable',
      detail: 'rateLimited',
      httpStatus: 429,
      retryAfterSeconds: 120,
    })
  })

  it('does not let a stalled response-body cancellation extend the deadline', async () => {
    let cancelCalled = false
    const stream = new ReadableStream<Uint8Array>(
      {
        cancel() {
          cancelCalled = true
          return new Promise<void>(() => undefined)
        },
      },
      { highWaterMark: 0 }
    )
    const { service } = serviceReturning(
      response(stream, {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const hung = new Promise<'hung'>((resolve) => {
      timer = setTimeout(() => resolve('hung'), 50)
    })

    const result = await Promise.race([service.discover(route()), hung])
    if (timer !== undefined) clearTimeout(timer)

    expect(result).toEqual({
      status: 'unavailable',
      reason: 'remoteDiscoveryUnavailable',
      detail: 'httpStatus',
      httpStatus: 404,
    })
    expect(cancelCalled).toBe(true)
  })

  it('does not reflect transport errors or their secret-bearing messages', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(
        'request https://user:secret@example.invalid/?token=super-secret failed'
      )
    })
    const service = new RemoteDiscoveryService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const result = await service.discover(route())

    expect(result).toEqual({
      status: 'unavailable',
      reason: 'remoteDiscoveryUnavailable',
      detail: 'networkError',
    })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('example.invalid')
  })

  it.each([
    'text/plain',
    'text/json',
    'application/problem+json',
    'application/json, text/plain',
    'application/json; charset=iso-8859-1',
  ])('rejects non-protocol content type %s', async (contentType) => {
    const { service } = serviceReturning(
      jsonResponse(document(), { headers: { 'content-type': contentType } })
    )

    expect(await service.discover(route())).toEqual({
      status: 'unavailable',
      reason: 'remoteDiscoveryUnavailable',
      detail: 'invalidContentType',
    })
  })

  it.each([
    'application/json',
    'Application/JSON',
    'application/json; charset=utf-8',
    'application/json ; charset="UTF-8"',
  ])('accepts the strict JSON media type form %s', async (contentType) => {
    const { service } = serviceReturning(
      jsonResponse(document(), { headers: { 'content-type': contentType } })
    )

    expect((await service.discover(route())).status).toBe('compatible')
  })

  it('rejects an absent content type', async () => {
    const raw = response(JSON.stringify(document()))
    raw.headers.delete('content-type')
    const { service } = serviceReturning(raw)

    expect(await service.discover(route())).toMatchObject({
      status: 'unavailable',
      detail: 'invalidContentType',
    })
  })

  it('stops reading a streamed body as soon as the byte cap is crossed', async () => {
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1
          controller.enqueue(new Uint8Array(32 * 1024))
        },
      },
      { highWaterMark: 0 }
    )
    const { service } = serviceReturning(response(stream), {
      maxBodyBytes: 40 * 1024,
    })

    expect(await service.discover(route())).toEqual({
      status: 'unavailable',
      reason: 'remoteDiscoveryUnavailable',
      detail: 'bodyTooLarge',
    })
    expect(pulls).toBeLessThanOrEqual(2)
  })

  it('counts decoded body bytes instead of rejecting an encoded Content-Length', async () => {
    const { service } = serviceReturning(
      response(JSON.stringify(document()), {
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'content-length': String(REMOTE_DISCOVERY_MAX_BODY_BYTES + 1),
        },
      })
    )

    expect((await service.discover(route())).status).toBe('compatible')
  })

  it('rejects malformed JSON without reflecting the response body', async () => {
    const { service } = serviceReturning(response('{"token":"do-not-log",'))

    const result = await service.discover(route())

    expect(result).toEqual({
      status: 'unavailable',
      reason: 'remoteDiscoveryUnavailable',
      detail: 'malformedDocument',
    })
    expect(JSON.stringify(result)).not.toContain('do-not-log')
  })

  it('rejects invalid UTF-8', async () => {
    const { service } = serviceReturning(response(new Uint8Array([0xff])))

    expect(await service.discover(route())).toMatchObject({
      status: 'unavailable',
      detail: 'malformedDocument',
    })
  })

  it.each([
    [
      'a duplicate top-level field',
      '{"app":"motrix-bridge","app":"evil","apiVersion":1}',
    ],
    [
      'an escaped duplicate field',
      '{"app":"motrix-bridge","\\u0061pp":"evil","apiVersion":1}',
    ],
    [
      'a duplicate nested field',
      '{"extensionPairing":{"protocol":"mbp1","protocol":"evil"}}',
    ],
    ['a prototype key', '{"__proto__":{"polluted":true}}'],
    ['a constructor key', '{"constructor":{"prototype":{}}}'],
  ])('rejects JSON with %s', async (_label, body) => {
    const { service } = serviceReturning(response(body))

    expect(await service.discover(route())).toMatchObject({
      status: 'unavailable',
      detail: 'malformedDocument',
    })
  })

  it.each([
    ['missing field', { appVersion: undefined }],
    ['wrong app', { app: 'not-motrix' }],
    ['fractional apiVersion', { apiVersion: 1.5 }],
    ['non-printable instanceId', { instanceId: 'server\nname' }],
    ['non-ASCII instanceId', { instanceId: '服务器' }],
    ['oversized instanceId', { instanceId: 'a'.repeat(129) }],
    ['control-bearing appVersion', { appVersion: '2.0\u0000.0' }],
    ['padded appVersion', { appVersion: ' 2.0.0 ' }],
    ['wrong runtime shape', { runtime: 'browser' }],
    [
      'empty MBP version list',
      { extensionPairing: { protocol: 'mbp1', versions: [] } },
    ],
    [
      'duplicate MBP versions',
      { extensionPairing: { protocol: 'mbp1', versions: [1, 1] } },
    ],
    ['malformed MDXP version', { applicationProtocols: { mdxp: ['latest'] } }],
    [
      'duplicate MDXP versions',
      { applicationProtocols: { mdxp: ['1.0', '1.0'] } },
    ],
    ['unknown top-level field', { token: 'legacy-secret' }],
    [
      'unknown nested field',
      {
        extensionPairing: {
          protocol: 'mbp1',
          versions: [1],
          pairUrl: 'https://attacker.example',
        },
      },
    ],
    ['server-supplied endpointId', { endpointId: 'attacker-choice' }],
  ])(
    'maps a document with %s to malformed/unavailable',
    async (_label, extra) => {
      const body = document(extra)
      if (
        Object.hasOwn(extra, 'appVersion') &&
        extra.appVersion === undefined
      ) {
        delete body.appVersion
      }
      const { service } = serviceReturning(jsonResponse(body))

      expect(await service.discover(route())).toEqual({
        status: 'unavailable',
        reason: 'remoteDiscoveryUnavailable',
        detail: 'malformedDocument',
      })
    }
  )

  it.each([
    [
      'older discovery API',
      { apiVersion: 0 },
      'backendUpgradeRequired',
      ['apiVersion'],
    ],
    [
      'newer discovery API',
      { apiVersion: 2 },
      'extensionUpgradeRequired',
      ['apiVersion'],
    ],
    [
      'older MBP and MDXP',
      {
        extensionPairing: { protocol: 'mbp1', versions: [0] },
        applicationProtocols: { mdxp: ['0.9'] },
      },
      'backendUpgradeRequired',
      ['extensionPairing', 'mdxp'],
    ],
    [
      'newer MBP and MDXP',
      {
        extensionPairing: { protocol: 'mbp1', versions: [2] },
        applicationProtocols: { mdxp: ['1.1', '2.0'] },
      },
      'extensionUpgradeRequired',
      ['extensionPairing', 'mdxp'],
    ],
    [
      'unknown pairing protocol',
      { extensionPairing: { protocol: 'mbp2', versions: [2] } },
      'backendUpgradeRequired',
      ['extensionPairing'],
    ],
    [
      'mixed older and newer versions',
      {
        extensionPairing: { protocol: 'mbp1', versions: [0, 2] },
        applicationProtocols: { mdxp: ['0.9', '1.1'] },
      },
      'backendUpgradeRequired',
      ['extensionPairing', 'mdxp'],
    ],
  ] as const)(
    'returns a version verdict only for a valid document with %s',
    async (_label, extra, reason, incompatibilities) => {
      const { service } = serviceReturning(jsonResponse(document(extra)))

      expect(await service.discover(route())).toMatchObject({
        status: 'incompatible',
        reason,
        incompatibilities,
        authority: { endpointId: 'server-a' },
        untrustedDocument: { instanceId: expect.any(String) },
      })
    }
  )

  it('treats a valid Desktop discovery document as the wrong target, not an upgrade verdict', async () => {
    const { service } = serviceReturning(
      jsonResponse(document({ runtime: 'electron' }))
    )

    expect(await service.discover(route())).toEqual({
      status: 'unavailable',
      reason: 'remoteDiscoveryUnavailable',
      detail: 'unexpectedRuntimeHint',
    })
  })

  it('times out a transport that never answers and aborts its signal', async () => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | undefined
    const fetchImpl = vi.fn(
      async (_input: unknown, init?: RequestInit): Promise<Response> => {
        requestSignal = init?.signal ?? undefined
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
      }
    )
    const service = new RemoteDiscoveryService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 50,
    })

    const pending = service.discover(route())
    await vi.advanceTimersByTimeAsync(50)

    expect(await pending).toEqual({
      status: 'unavailable',
      reason: 'remoteDiscoveryUnavailable',
      detail: 'requestTimedOut',
    })
    expect(requestSignal?.aborted).toBe(true)
  })

  it('enforces the headers deadline even when fetch ignores AbortSignal forever', async () => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | undefined
    const fetchImpl = vi.fn(
      async (_input: unknown, init?: RequestInit): Promise<Response> => {
        requestSignal = init?.signal ?? undefined
        return new Promise<Response>(() => undefined)
      }
    )
    const service = new RemoteDiscoveryService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 50,
    })

    const pending = service.discover(route())
    await vi.advanceTimersByTimeAsync(50)

    await expect(pending).resolves.toMatchObject({
      status: 'unavailable',
      detail: 'requestTimedOut',
    })
    expect(requestSignal?.aborted).toBe(true)
  })

  it('cancels a response that arrives only after the headers deadline', async () => {
    vi.useFakeTimers()
    let resolveFetch!: (response: Response) => void
    let cancelled = false
    const fetchImpl = vi.fn(
      (): Promise<Response> =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        })
    )
    const service = new RemoteDiscoveryService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 50,
    })

    const pending = service.discover(route())
    await vi.advanceTimersByTimeAsync(50)
    await expect(pending).resolves.toMatchObject({
      status: 'unavailable',
      detail: 'requestTimedOut',
    })

    resolveFetch(
      response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true
          },
        })
      )
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(cancelled).toBe(true)
  })

  it('honors a caller abort without issuing a request when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { service, fetchImpl } = serviceReturning(jsonResponse())

    expect(
      await service.discover(route(), { signal: controller.signal })
    ).toEqual({
      status: 'unavailable',
      reason: 'remoteDiscoveryUnavailable',
      detail: 'requestAborted',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('honors a caller abort while fetch is pending', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(
      async (_input: unknown, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
    )
    const service = new RemoteDiscoveryService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const pending = service.discover(route(), { signal: controller.signal })
    controller.abort()

    expect(await pending).toMatchObject({
      status: 'unavailable',
      detail: 'requestAborted',
    })
  })

  it('applies the timeout while the response body itself is stalled', async () => {
    vi.useFakeTimers()
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
        return new Promise<void>(() => undefined)
      },
    })
    const { service } = serviceReturning(response(stream), { timeoutMs: 50 })

    const pending = service.discover(route())
    await vi.advanceTimersByTimeAsync(50)

    expect(await pending).toMatchObject({
      status: 'unavailable',
      detail: 'requestTimedOut',
    })
    expect(cancelled).toBe(true)
  })

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 10_001 },
    { timeoutMs: 1.5 },
    { maxBodyBytes: 0 },
    { maxBodyBytes: REMOTE_DISCOVERY_MAX_BODY_BYTES + 1 },
    { maxBodyBytes: 1.5 },
  ])('rejects an out-of-policy resource bound %j', (options) => {
    expect(
      () =>
        new RemoteDiscoveryService({
          fetchImpl: vi.fn() as unknown as typeof fetch,
          ...options,
        })
    ).toThrow()
  })
})
