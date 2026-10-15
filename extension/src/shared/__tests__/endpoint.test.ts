import { describe, expect, it } from 'vitest'
import { normalizeRemoteEndpoint, parseRemoteEndpoint } from '@/shared/endpoint'

describe('remote endpoint parsing', () => {
  it('canonicalizes host casing, default ports, and trailing slashes', () => {
    expect(normalizeRemoteEndpoint('wss://MOTRIX.Example:443/')).toBe(
      'wss://motrix.example'
    )
    expect(normalizeRemoteEndpoint('WSS://[2001:DB8::1]:443/bridge///')).toBe(
      'wss://[2001:db8::1]/bridge'
    )
    expect(normalizeRemoteEndpoint('WS://NAS.Local:80/bridge///')).toBe(
      'ws://nas.local/bridge'
    )
  })

  it('preserves a path as a reverse-proxy base path', () => {
    expect(normalizeRemoteEndpoint('wss://motrix.example/bridge/')).toBe(
      'wss://motrix.example/bridge'
    )
  })

  it('reports effective websocket ports', () => {
    expect(parseRemoteEndpoint('wss://motrix.example').port).toBe(443)
    expect(parseRemoteEndpoint('wss://motrix.example:9443').port).toBe(9443)
    expect(parseRemoteEndpoint('ws://nas.local').port).toBe(80)
    expect(parseRemoteEndpoint('ws://nas.local:8888').port).toBe(8888)
  })

  it.each([
    'https://motrix.example',
    'wss://user:secret@motrix.example',
    'wss://@motrix.example',
    'wss://motrix.example?token=secret',
    'wss://motrix.example?',
    'wss://motrix.example#fragment',
    'wss://motrix.example#',
    ' wss://motrix.example',
    'wss://motrix.example ',
    'wss://motrix.example/a b',
    'wss://motrix.example/a\u0085b',
    'wss:\\motrix.example\\bridge',
    'wss://motrix.example/bridge\u0000tail',
    'wss://motrix.example/bridge%2ftail',
    'wss://motrix.example/bridge%5ctail',
    'wss://motrix.example/bridge%252ftail',
    'wss://motrix.example/bridge%25%35%63tail',
    'wss://motrix.example/bridge%zz',
    `wss://motrix.example/${'a'.repeat(4096)}`,
    'not a url',
  ])('rejects ambiguous or unsafe URL %s', (value) => {
    expect(() => parseRemoteEndpoint(value)).toThrow()
  })

  it('is byte-stable after canonicalization', () => {
    const canonical = normalizeRemoteEndpoint(
      'WSS://B\u00dcCHER.example:443/bridge/\u8d44\u6e90///'
    )
    expect(normalizeRemoteEndpoint(canonical)).toBe(canonical)
    expect(normalizeRemoteEndpoint('ws://nas.local/bridge')).toBe(
      'ws://nas.local/bridge'
    )
  })
})
