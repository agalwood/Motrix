import { describe, expect, it } from 'vitest'
import { parseElectronProxyChain } from './system-proxy'

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
