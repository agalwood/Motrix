import { NonceService } from '@core/bridge/mbp1/nonce-service'
import { describe, expect, it } from 'vitest'
import { parseRemoteExtensionConfig } from './remote-extension-config'
import {
  deriveRemoteExtensionRouteTargets,
  evaluateRemoteExtensionRoute,
} from './remote-extension-route-policy'

const NONCE = 'AQIDBAUGBwgJCgsMDQ4PEA'

function enabled(publicWebSocketUrl = 'wss://motrix.example/bridge') {
  return parseRemoteExtensionConfig({
    MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
    MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: publicWebSocketUrl,
    MOTRIX_PUBLIC_URL: 'https://motrix.example/operator',
  })
}

function decide(
  rawTarget: string,
  options: {
    method?: string
    transport?: 'http' | 'websocket'
    websocketUrl?: string
  } = {}
) {
  return evaluateRemoteExtensionRoute(enabled(options.websocketUrl), {
    rawTarget,
    method: options.method ?? 'GET',
    transport: options.transport ?? 'http',
  })
}

describe('deriveRemoteExtensionRouteTargets', () => {
  it('derives exactly four paths under a configured prefix', () => {
    expect(deriveRemoteExtensionRouteTargets(enabled())).toEqual({
      discovery: '/bridge/discovery',
      nonce: '/bridge/nonce',
      pair: '/bridge/pair',
      v1: '/bridge/v1',
    })
  })

  it('derives root paths without a double slash', () => {
    expect(
      deriveRemoteExtensionRouteTargets(enabled('wss://motrix.example/'))
    ).toEqual({
      discovery: '/discovery',
      nonce: '/nonce',
      pair: '/pair',
      v1: '/v1',
    })
  })

  it('derives the same route surface for an explicit WS endpoint', () => {
    expect(
      deriveRemoteExtensionRouteTargets(enabled('ws://nas.local:8888/bridge'))
    ).toEqual({
      discovery: '/bridge/discovery',
      nonce: '/bridge/nonce',
      pair: '/bridge/pair',
      v1: '/bridge/v1',
    })
  })

  it('preserves the canonical encoded prefix byte-for-byte', () => {
    expect(
      deriveRemoteExtensionRouteTargets(
        enabled('wss://motrix.example/bridge/%E8%B5%84%E6%BA%90')
      )
    ).toMatchObject({
      pair: '/bridge/%E8%B5%84%E6%BA%90/pair',
    })
  })

  it.each([
    parseRemoteExtensionConfig({}),
    parseRemoteExtensionConfig({
      MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
      MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: 'https://motrix.example/bridge',
      MOTRIX_PUBLIC_URL: 'https://motrix.example',
    }),
  ])('returns no targets for a closed configuration', (config) => {
    expect(deriveRemoteExtensionRouteTargets(config)).toBeNull()
  })

  it('rejects copied, deserialized, and structurally forged enabled configs', () => {
    const parsed = enabled()
    if (parsed.status !== 'enabled')
      throw new Error('test config is not enabled')
    const selfConsistentEncodedSeparator = {
      ...parsed,
      publicWebSocketBaseUrl: 'wss://motrix.example/bridge%2Fadmin',
      publicWebSocketBasePath: '/bridge%2Fadmin',
    } as const
    const overlongPath = `/${'a'.repeat(5_000)}`
    const selfConsistentOverlong = {
      ...parsed,
      publicWebSocketBaseUrl: `wss://motrix.example${overlongPath}`,
      publicWebSocketBasePath: overlongPath,
    } as const

    expect(deriveRemoteExtensionRouteTargets({ ...parsed })).toBeNull()
    expect(
      deriveRemoteExtensionRouteTargets(JSON.parse(JSON.stringify(parsed)))
    ).toBeNull()
    expect(
      deriveRemoteExtensionRouteTargets(selfConsistentEncodedSeparator)
    ).toBeNull()
    expect(deriveRemoteExtensionRouteTargets(selfConsistentOverlong)).toBeNull()
  })
})

describe('evaluateRemoteExtensionRoute', () => {
  it.each([
    ['/bridge/discovery', 'GET', 'http', 'discovery'],
    ['/bridge/nonce', 'POST', 'http', 'nonce'],
    [`/bridge/pair?nonce=${NONCE}`, 'GET', 'websocket', 'pair'],
    ['/bridge/v1', 'GET', 'websocket', 'v1'],
  ] as const)(
    'admits the exact %s request',
    (rawTarget, method, transport, route) => {
      expect(decide(rawTarget, { method, transport })).toMatchObject({
        ok: true,
        route,
      })
    }
  )

  it('returns the validated pair nonce without decoding aliases', () => {
    expect(
      decide(`/bridge/pair?nonce=${NONCE}`, { transport: 'websocket' })
    ).toEqual({ ok: true, route: 'pair', pairNonce: NONCE })
  })

  it('accepts every nonce issued by the shared MBP1 NonceService', () => {
    const nonces = new NonceService({ maxOutstanding: 32 })
    for (let index = 0; index < 32; index += 1) {
      const issued = nonces.issue(null)
      expect('nonce' in issued).toBe(true)
      if (!('nonce' in issued)) throw new Error('nonce fixture was limited')
      expect(
        decide(`/bridge/pair?nonce=${issued.nonce}`, {
          transport: 'websocket',
        })
      ).toEqual({ ok: true, route: 'pair', pairNonce: issued.nonce })
    }
  })

  it.each([
    '/bridge',
    '/bridge/',
    '/bridge/pair/',
    '/pair',
    '/bridge//pair',
    '/bridge/./pair',
    '/bridge/x/../pair',
    '/bridge/%2e%2e/pair',
    '/bridge%2Fpair',
    '/bridge/%70air',
    '/BRIDGE/pair',
  ])('rejects non-exact raw path %j', (rawTarget) => {
    expect(decide(rawTarget, { transport: 'websocket' })).toEqual({
      ok: false,
      reason: 'unknown-route',
    })
  })

  it.each([
    `/bridge/pair?nonce=${NONCE}&token=legacy`,
    '/bridge/pair?token=legacy',
    '/bridge/pair',
    '/bridge/pair?',
    `/bridge/pair?nonce=${NONCE}&nonce=${NONCE}`,
    `/bridge/pair?nonce=${NONCE}%00`,
    '/bridge/pair?nonce=AAAAAAAAAAAAAAAAAAAAAB',
    `/bridge/pair?nonce=${NONCE}=`,
    '/bridge/pair?nonce=short',
    `/bridge/pair?nonce%3d${NONCE}`,
  ])('rejects ambiguous or non-canonical pair query %j', (rawTarget) => {
    expect(decide(rawTarget, { transport: 'websocket' })).toEqual({
      ok: false,
      reason: 'malformed-pair-query',
    })
  })

  it.each([
    '/bridge/discovery?',
    '/bridge/discovery?token=legacy',
    '/bridge/nonce?x=1',
    '/bridge/v1?token=legacy',
  ])('rejects a query on non-pair route %j', (rawTarget) => {
    expect(
      decide(rawTarget, {
        method: rawTarget.includes('/nonce') ? 'POST' : 'GET',
        transport: rawTarget.includes('/v1') ? 'websocket' : 'http',
      })
    ).toEqual({ ok: false, reason: 'query-not-allowed' })
  })

  it.each([
    ['/bridge/discovery', 'POST', 'http'],
    ['/bridge/nonce', 'GET', 'http'],
    [`/bridge/pair?nonce=${NONCE}`, 'POST', 'websocket'],
    ['/bridge/v1', 'POST', 'websocket'],
  ] as const)(
    'rejects the wrong method for %s',
    (rawTarget, method, transport) => {
      expect(decide(rawTarget, { method, transport })).toEqual({
        ok: false,
        reason: 'method-not-allowed',
      })
    }
  )

  it.each([
    ['/bridge/discovery', 'GET', 'websocket'],
    ['/bridge/nonce', 'POST', 'websocket'],
    [`/bridge/pair?nonce=${NONCE}`, 'GET', 'http'],
    ['/bridge/v1', 'GET', 'http'],
  ] as const)(
    'rejects the wrong transport for %s',
    (rawTarget, method, transport) => {
      expect(decide(rawTarget, { method, transport })).toEqual({
        ok: false,
        reason: 'transport-mismatch',
      })
    }
  )

  it.each([
    `/bridge/pair?nonce=${NONCE}#fragment`,
    `/bridge/pair?nonce=${NONCE}\\suffix`,
    `/bridge/pair?nonce=${NONCE} suffix`,
    `/bridge/pair?nonce=${NONCE}\nnext`,
  ])('rejects malformed raw target %j', (rawTarget) => {
    expect(decide(rawTarget, { transport: 'websocket' })).toEqual({
      ok: false,
      reason: 'malformed-target',
    })
  })

  it.each([
    null,
    1,
    {},
    { toString: () => '/bridge/v1' },
    '/bridge/服务器/pair',
    `/${'a'.repeat(8_192)}`,
  ])(
    'rejects an invalid runtime raw target without throwing: %j',
    (rawTarget) => {
      expect(
        evaluateRemoteExtensionRoute(enabled(), {
          rawTarget,
          method: 'GET',
          transport: 'websocket',
        } as never)
      ).toEqual({ ok: false, reason: 'malformed-target' })
    }
  )

  it('rejects a throwing request getter with a fixed result', () => {
    const request = Object.defineProperty({}, 'rawTarget', {
      get() {
        throw new Error('secret-sentinel')
      },
    })
    expect(evaluateRemoteExtensionRoute(enabled(), request as never)).toEqual({
      ok: false,
      reason: 'malformed-target',
    })
  })

  it.each([
    ['https://motrix.example/bridge/v1', 'unknown-route'],
    ['motrix.example:443', 'unknown-route'],
    ['*', 'unknown-route'],
  ] as const)('rejects non-origin-form target %j', (rawTarget, reason) => {
    expect(decide(rawTarget, { transport: 'websocket' })).toEqual({
      ok: false,
      reason,
    })
  })

  it('distinguishes the raw-target length boundary without allocating routes', () => {
    expect(decide(`/${'a'.repeat(8_191)}`)).toEqual({
      ok: false,
      reason: 'unknown-route',
    })
    expect(decide(`/${'a'.repeat(8_192)}`)).toEqual({
      ok: false,
      reason: 'malformed-target',
    })
  })

  it('keeps every route closed for a disabled feature', () => {
    expect(
      evaluateRemoteExtensionRoute(parseRemoteExtensionConfig({}), {
        rawTarget: `/pair?nonce=${NONCE}`,
        method: 'GET',
        transport: 'websocket',
      })
    ).toEqual({ ok: false, reason: 'feature-closed' })
  })
})
