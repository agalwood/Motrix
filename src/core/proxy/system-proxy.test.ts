import { describe, expect, it } from 'vitest'
import { parseElectronProxyChain, parseProxyEnvironment } from './system-proxy'

describe('parseElectronProxyChain', () => {
  it('returns null for DIRECT', () => {
    expect(parseElectronProxyChain('DIRECT')).toBeNull()
  })

  it('parses PROXY entry as http', () => {
    expect(parseElectronProxyChain('PROXY 127.0.0.1:8080')).toEqual({
      protocol: 'http',
      host: '127.0.0.1',
      port: 8080,
    })
  })

  it('parses HTTPS entry', () => {
    expect(parseElectronProxyChain('HTTPS 1.2.3.4:443')).toEqual({
      protocol: 'https',
      host: '1.2.3.4',
      port: 443,
    })
  })

  it('parses SOCKS5 entry', () => {
    expect(parseElectronProxyChain('SOCKS5 1.2.3.4:1080')).toEqual({
      protocol: 'socks5',
      host: '1.2.3.4',
      port: 1080,
    })
  })

  it('takes the first non-DIRECT entry from a chain', () => {
    expect(parseElectronProxyChain('DIRECT; PROXY a:1; PROXY b:2')).toEqual({
      protocol: 'http',
      host: 'a',
      port: 1,
    })
  })

  it('returns null when chain is all DIRECT', () => {
    expect(parseElectronProxyChain('DIRECT; DIRECT')).toBeNull()
  })

  it('returns null on empty or garbage input', () => {
    expect(parseElectronProxyChain('')).toBeNull()
    expect(parseElectronProxyChain('garbage')).toBeNull()
    expect(parseElectronProxyChain('PROXY')).toBeNull()
    expect(parseElectronProxyChain('PROXY foo')).toBeNull()
  })
})

describe('parseProxyEnvironment', () => {
  it('prefers HTTPS_PROXY and imports credentials plus NO_PROXY', () => {
    expect(
      parseProxyEnvironment({
        HTTPS_PROXY: 'http://alice:p%40ss@proxy.example:3128',
        HTTP_PROXY: 'http://fallback.example:8080',
        NO_PROXY: 'localhost, 127.0.0.1, .internal',
      })
    ).toEqual({
      protocol: 'http',
      host: 'proxy.example',
      port: 3128,
      user: 'alice',
      password: 'p@ss',
      bypass: ['localhost', '127.0.0.1', '.internal'],
    })
  })

  it('supports lowercase SOCKS and default ports', () => {
    expect(parseProxyEnvironment({ all_proxy: 'socks5h://127.0.0.1' })).toEqual(
      {
        protocol: 'socks5',
        host: '127.0.0.1',
        port: 1080,
      }
    )
  })

  it('accepts a host and port without an explicit scheme', () => {
    expect(parseProxyEnvironment({ http_proxy: 'proxy.local:8888' })).toEqual({
      protocol: 'http',
      host: 'proxy.local',
      port: 8888,
    })
  })

  it('returns null for absent, malformed, or unsupported proxy values', () => {
    expect(parseProxyEnvironment({})).toBeNull()
    expect(parseProxyEnvironment({ HTTPS_PROXY: 'not a proxy' })).toBeNull()
    expect(parseProxyEnvironment({ HTTPS_PROXY: 'ftp://proxy:21' })).toBeNull()
  })
})
