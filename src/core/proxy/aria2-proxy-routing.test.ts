// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  decideAria2ProxyRoute,
  extractAria2ProxyCredentials,
  normalizeAria2TaskProxyUrl,
  normalizeProxyUrl,
} from './aria2-proxy-routing'

describe('normalizeProxyUrl', () => {
  it.each([
    ['proxy.example:8080', 'http://proxy.example:8080/'],
    ['user:p%3As@proxy.example:8080', 'http://user:p%3As@proxy.example:8080/'],
    ['socks5://proxy.example:1080', 'socks5://proxy.example:1080'],
    ['[2001:db8::1]:8080', 'http://[2001:db8::1]:8080/'],
    ['[0:0:0:0:0:0:0:1]:8080', 'http://[::1]:8080/'],
  ])('normalizes %s as %s', (input, expected) => {
    expect(normalizeProxyUrl(input)?.toString()).toBe(expected)
  })

  it.each([
    '',
    '   ',
    ' proxy.example ',
    'HTTPS://proxy.example:8443',
    'ftp://proxy.example:21',
    'socks5h://proxy.example:1080',
    'http://',
    'http:proxy.example',
    'http://proxy.example:0',
    'http://proxy.example:70000',
    'http://proxy.example/path',
    'http://proxy.example?',
    'http://proxy.example?mode=tunnel',
    'http://proxy.example#',
    'http://proxy.example#fragment',
    'http://%6cocalhost:8080',
    'http://127.1:8080',
    'http://proxy.example:8\t0',
    'http:\\proxy.example:8080',
  ])('rejects an unsupported proxy value: %s', (input) => {
    expect(normalizeProxyUrl(input)).toBeNull()
  })
})

describe('normalizeAria2TaskProxyUrl', () => {
  it('accepts aria2 HTTP syntax but rejects SOCKS5 without a per-task bridge', () => {
    expect(
      normalizeAria2TaskProxyUrl('https://proxy.example:8443')?.protocol
    ).toBe('https:')
    expect(normalizeAria2TaskProxyUrl('http://127.1:8080')?.hostname).toBe(
      '127.0.0.1'
    )
    expect(normalizeAria2TaskProxyUrl('socks5://proxy.example:1080')).toBeNull()
  })
})

describe('extractAria2ProxyCredentials', () => {
  it('decodes URI userinfo for aria2 dedicated credential options', () => {
    expect(
      extractAria2ProxyCredentials('http://a%40b:p%3As@proxy.example:8080')
    ).toEqual({ username: 'a@b', password: 'p:s' })
    expect(extractAria2ProxyCredentials('proxy.example:8080')).toEqual({
      username: '',
      password: '',
    })
    expect(
      extractAria2ProxyCredentials('http://user:pass@[0:0:0:0:0:0:0:1]:8080')
    ).toEqual({ username: 'user', password: 'pass' })
    expect(extractAria2ProxyCredentials('http://user:pass@127.1:8080')).toEqual(
      { username: 'user', password: 'pass' }
    )
  })

  it('fails closed when credentials cannot be represented exactly', () => {
    expect(
      extractAria2ProxyCredentials('http://user%zz:pass@proxy.example:8080')
    ).toBeNull()
    expect(
      extractAria2ProxyCredentials('http://user:%00@proxy.example:8080')
    ).toBeNull()
    expect(
      extractAria2ProxyCredentials(
        'http://user%0Ahttp-proxy%3Dhttp%3A%2F%2Fevil:pass@proxy.example:8080'
      )
    ).toBeNull()
    expect(
      extractAria2ProxyCredentials('http://user:%7F@proxy.example:8080')
    ).toBeNull()
  })
})

describe('decideAria2ProxyRoute', () => {
  it('uses exact host and IP matching', () => {
    expect(decideAria2ProxyRoute('http://localhost/file', 'localhost')).toBe(
      'direct'
    )
    expect(
      decideAria2ProxyRoute('http://sub.localhost/file', 'localhost')
    ).toBe('proxy')
    expect(decideAria2ProxyRoute('http://127.0.0.1/file', '127.0.0.1')).toBe(
      'direct'
    )
    expect(decideAria2ProxyRoute('http://[::1]/file', '::1')).toBe('direct')
  })

  it('strips spaces like aria2 and skips empty entries', () => {
    expect(
      decideAria2ProxyRoute(
        'http://localhost/file',
        ' , example.test, localhost, '
      )
    ).toBe('direct')
  })

  it('rejects control characters in targets and no-proxy policy', () => {
    expect(
      decideAria2ProxyRoute(
        'http://localhost/file',
        'localhost\nhttp-proxy=http://evil'
      )
    ).toBe('unsupported')
    expect(decideAria2ProxyRoute('http://local\thost/file', '')).toBe(
      'unsupported'
    )
  })

  it('keeps aria2 exact and suffix comparisons case-sensitive', () => {
    expect(decideAria2ProxyRoute('http://localhost/file', 'LOCALHOST')).toBe(
      'proxy'
    )
    expect(decideAria2ProxyRoute('http://api.internal/file', '.INTERNAL')).toBe(
      'proxy'
    )
    expect(decideAria2ProxyRoute('http://LOCALHOST/file', 'LOCALHOST')).toBe(
      'direct'
    )
    expect(decideAria2ProxyRoute('http://LOCALHOST/file', 'localhost')).toBe(
      'proxy'
    )
    expect(decideAria2ProxyRoute('http://API.Internal/file', '.internal')).toBe(
      'proxy'
    )
  })

  it('matches a leading-dot domain only for subdomains', () => {
    expect(
      decideAria2ProxyRoute('https://api.internal/file', '.internal')
    ).toBe('direct')
    expect(
      decideAria2ProxyRoute('https://deep.api.internal/file', '.internal')
    ).toBe('direct')
    expect(decideAria2ProxyRoute('https://internal/file', '.internal')).toBe(
      'proxy'
    )
  })

  it('does not treat a leading dot as a suffix for numeric hosts', () => {
    expect(decideAria2ProxyRoute('http://127.0.0.1/file', '.0.0.1')).toBe(
      'proxy'
    )
  })

  it('treats wildcard, port, and URL-like entries exactly as aria2 does', () => {
    expect(
      decideAria2ProxyRoute('https://api.internal/file', '*.internal')
    ).toBe('proxy')
    expect(
      decideAria2ProxyRoute('http://127.0.0.1:8080/file', '127.0.0.1:8080')
    ).toBe('proxy')
    expect(
      decideAria2ProxyRoute('https://api.internal/file', 'https://api.internal')
    ).toBe('proxy')
  })

  it('matches IPv4 and IPv6 CIDR without resolving hostnames', () => {
    expect(
      decideAria2ProxyRoute('http://127.22.33.44/file', '127.0.0.0/8')
    ).toBe('direct')
    expect(decideAria2ProxyRoute('http://128.0.0.1/file', '127.0.0.0/8')).toBe(
      'proxy'
    )
    expect(
      decideAria2ProxyRoute('http://[2001:db8::42]/file', '2001:db8::/32')
    ).toBe('direct')
    expect(
      decideAria2ProxyRoute('http://service.internal/file', '127.0.0.0/8')
    ).toBe('proxy')
    expect(decideAria2ProxyRoute('http://127.1/file', '127.0.0.0/8')).toBe(
      'unsupported'
    )
    expect(decideAria2ProxyRoute('http://%6cocalhost/file', 'localhost')).toBe(
      'unsupported'
    )
  })

  it('clamps an oversized CIDR prefix to the address width like aria2', () => {
    expect(
      decideAria2ProxyRoute('http://127.0.0.1/file', '127.0.0.1/999')
    ).toBe('direct')
    expect(
      decideAria2ProxyRoute('http://127.0.0.2/file', '127.0.0.1/999')
    ).toBe('proxy')
  })

  it('ignores malformed CIDR entries instead of changing later matches', () => {
    expect(
      decideAria2ProxyRoute(
        'http://localhost/file',
        '127.0.0.0/not-a-prefix,localhost'
      )
    ).toBe('direct')
    expect(decideAria2ProxyRoute('http://127.0.0.1/file', 'not-an-ip/8')).toBe(
      'proxy'
    )
  })

  it('can be called for every redirect hop', () => {
    const noProxy = '.internal,10.0.0.0/8'
    expect(
      decideAria2ProxyRoute('https://downloads.example/start', noProxy)
    ).toBe('proxy')
    expect(
      decideAria2ProxyRoute('https://mirror.internal/release', noProxy)
    ).toBe('direct')
    expect(decideAria2ProxyRoute('http://10.20.30.40/release', noProxy)).toBe(
      'direct'
    )
  })

  it('returns unsupported only when the target itself cannot be routed', () => {
    expect(decideAria2ProxyRoute('not a URL', 'localhost')).toBe('unsupported')
    expect(decideAria2ProxyRoute('ftp://localhost/file', 'localhost')).toBe(
      'unsupported'
    )
    expect(decideAria2ProxyRoute('HTTP://LOCALHOST/file', 'LOCALHOST')).toBe(
      'unsupported'
    )
  })
})
