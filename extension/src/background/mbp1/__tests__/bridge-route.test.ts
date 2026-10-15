import { describe, expect, it } from 'vitest'
import {
  createRemoteBackendAuthority,
  type RemoteBackendAuthority,
} from '@/background/mbp1/backend-authority'
import {
  type BridgeRoute,
  deriveRemoteBridgeRoute,
  isCanonicalMbp1PairNonce,
  remotePairUrl,
} from '@/background/mbp1/bridge-route'

const NONCE = 'AQIDBAUGBwgJCgsMDQ4PEA'

function route(wsBase: string) {
  return deriveRemoteBridgeRoute(
    createRemoteBackendAuthority({ endpointId: 'server-a', wsBase })
  )
}

describe('RemoteBridgeRoute', () => {
  it('derives HTTPS and WSS routes from a canonical root base', () => {
    const result = route('wss://MOTRIX.Example:443/')

    expect(result.authority.canonicalWsBase).toBe('wss://motrix.example')
    expect(result.discoveryUrl).toBe('https://motrix.example/discovery')
    expect(result.nonceUrl).toBe('https://motrix.example/nonce')
    expect(remotePairUrl(result, NONCE)).toBe(
      `wss://motrix.example/pair?nonce=${NONCE}`
    )
    expect(result.v1Url).toBe('wss://motrix.example/v1')
  })

  it('derives HTTP and WS routes without changing the configured scheme', () => {
    const result = route('ws://NAS.Local:80/bridge/')

    expect(result.authority.canonicalWsBase).toBe('ws://nas.local/bridge')
    expect(result.discoveryUrl).toBe('http://nas.local/bridge/discovery')
    expect(result.nonceUrl).toBe('http://nas.local/bridge/nonce')
    expect(remotePairUrl(result, NONCE)).toBe(
      `ws://nas.local/bridge/pair?nonce=${NONCE}`
    )
    expect(result.v1Url).toBe('ws://nas.local/bridge/v1')
  })

  it('preserves a reverse-proxy base path and non-default port', () => {
    const result = route('wss://motrix.example:8443/api/bridge///')

    expect(result.discoveryUrl).toBe(
      'https://motrix.example:8443/api/bridge/discovery'
    )
    expect(result.nonceUrl).toBe('https://motrix.example:8443/api/bridge/nonce')
    expect(remotePairUrl(result, NONCE)).toBe(
      `wss://motrix.example:8443/api/bridge/pair?nonce=${NONCE}`
    )
    expect(result.v1Url).toBe('wss://motrix.example:8443/api/bridge/v1')
  })

  it('preserves canonical IPv6 authority syntax', () => {
    const result = route('wss://[2001:DB8::1]:443/gateway/')

    expect(result.discoveryUrl).toBe('https://[2001:db8::1]/gateway/discovery')
    expect(result.nonceUrl).toBe('https://[2001:db8::1]/gateway/nonce')
    expect(remotePairUrl(result, NONCE)).toBe(
      `wss://[2001:db8::1]/gateway/pair?nonce=${NONCE}`
    )
    expect(result.v1Url).toBe('wss://[2001:db8::1]/gateway/v1')
  })

  it('emits the canonical nonce as one query value', () => {
    const result = route('wss://motrix.example/bridge')
    const pairUrl = remotePairUrl(result, NONCE)

    expect(pairUrl).toBe(`wss://motrix.example/bridge/pair?nonce=${NONCE}`)
    const parsed = new URL(pairUrl)
    expect([...parsed.searchParams.keys()]).toEqual(['nonce'])
    expect(parsed.searchParams.get('nonce')).toBe(NONCE)
  })

  it.each([
    '',
    'fresh_base64url_nonce-123',
    'AAAAAAAAAAAAAAAAAAAAAB',
    'AQIDBAUGBwgJCgsMDQ4PEA=',
    'AQIDBAUGBwgJCgsMDQ4PE+',
    'a&b=c d/?#%',
  ])('rejects a non-canonical nonce %j', (nonce) => {
    expect(isCanonicalMbp1PairNonce(nonce)).toBe(false)
    expect(() => remotePairUrl(route('wss://motrix.example'), nonce)).toThrow(
      'MBP1 pair nonce is not canonical'
    )
  })

  it('never emits a legacy token query parameter', () => {
    const result = route('wss://motrix.example/bridge')
    const urls = [
      result.discoveryUrl,
      result.nonceUrl,
      remotePairUrl(result, NONCE),
      result.v1Url,
    ]

    for (const url of urls) {
      const parsed = new URL(url)
      expect(parsed.searchParams.has('token')).toBe(false)
      expect(url).not.toContain('?token=')
      expect(url).not.toContain('&token=')
    }
  })

  it('rejects a structurally manufactured authority', () => {
    const unsafe = {
      kind: 'remote',
      endpointId: 'server-a',
      canonicalWsBase: 'ws://motrix.example',
    } as unknown as RemoteBackendAuthority

    expect(() => deriveRemoteBridgeRoute(unsafe)).toThrow()
  })

  it('rejects a forged route with a legal authority and attacker URLs', () => {
    const issued = route('wss://motrix.example/bridge')
    const forged = {
      // Spreading copies even the private enumerable symbol brand. The
      // module's runtime issuance registry must still reject the new object.
      ...issued,
      discoveryUrl: 'https://attacker.example/discovery',
      nonceUrl: 'https://attacker.example/nonce',
      v1Url: 'wss://attacker.example/v1',
    } satisfies BridgeRoute

    expect(() => remotePairUrl(forged, NONCE)).toThrow(
      'BridgeRoute must be created by deriveRemoteBridgeRoute'
    )
  })

  it('rejects a persisted and deserialized route', () => {
    const original = route('wss://motrix.example/bridge')
    const restored = JSON.parse(JSON.stringify(original)) as BridgeRoute

    expect(() => remotePairUrl(restored, NONCE)).toThrow(
      'BridgeRoute must be created by deriveRemoteBridgeRoute'
    )
  })

  it.each([
    'wss://user:secret@motrix.example',
    'wss://motrix.example/bridge?token=legacy',
    'wss://motrix.example/bridge#fragment',
  ])('rejects an ambiguous or credential-bearing base %s', (wsBase) => {
    expect(() => route(wsBase)).toThrow()
  })
})
