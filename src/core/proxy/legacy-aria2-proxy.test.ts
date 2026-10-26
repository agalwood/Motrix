import { describe, expect, it } from 'vitest'
import { normalizeAria2TaskProxyUrl } from './aria2-proxy-routing'
import { normalizeLegacyAria2ProxyUrl } from './legacy-aria2-proxy'

describe('legacy aria2 proxy option normalization', () => {
  it.each([
    ['proxy.example', 'http://proxy.example/'],
    ['http://proxy.example', 'http://proxy.example/'],
    ['http://proxy.example:443', 'http://proxy.example:443/'],
    ['https://proxy.example', 'http://proxy.example:443/'],
    ['https://proxy.example:443', 'http://proxy.example:443/'],
    ['https://proxy.example:80', 'http://proxy.example/'],
    ['https://proxy.example:8181', 'http://proxy.example:8181/'],
    ['ftp://proxy.example', 'http://proxy.example:21/'],
    ['ftp://proxy.example:21', 'http://proxy.example:21/'],
    ['ftp://proxy.example:80', 'http://proxy.example/'],
    ['ftp://proxy.example:8181', 'http://proxy.example:8181/'],
    [
      'https://old%40user:literal%2540pass@[::1]',
      'http://old%40user:literal%2540pass@[::1]:443/',
    ],
  ])('matches native protocol and port for %s', (input, expected) => {
    expect(normalizeLegacyAria2ProxyUrl(input)?.href).toBe(expected)
  })

  it.each([
    '',
    'socks5://proxy.example:1080',
    'ftp://proxy.example/path',
    'https://proxy.example:0',
    'https://proxy.example?query',
    'https://proxy.example\\other',
  ])('rejects unsupported syntax %s', (input) => {
    expect(normalizeLegacyAria2ProxyUrl(input)).toBeNull()
  })

  it('keeps ordinary task proxy semantics unchanged', () => {
    expect(normalizeAria2TaskProxyUrl('https://proxy.example')?.href).toBe(
      'https://proxy.example/'
    )
    expect(normalizeAria2TaskProxyUrl('ftp://proxy.example')).toBeNull()
  })
})
