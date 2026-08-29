import { DEFAULT_PROXY_SETTINGS } from '@shared/schemas/proxy-settings'
import { describe, expect, it } from 'vitest'
import {
  proxyToAria2Options,
  proxyToDownloadRequestOptions,
  proxyToElectronConfig,
  proxyToFetchUrl,
} from './serializers'

const enabledHttp = {
  ...DEFAULT_PROXY_SETTINGS,
  enabled: true,
  protocol: 'http' as const,
  host: 'p.example.com',
  port: 8080,
}

describe('proxyToAria2Options', () => {
  it('returns null when disabled', () => {
    expect(proxyToAria2Options(DEFAULT_PROXY_SETTINGS)).toBeNull()
  })

  it('returns null when download scope is off', () => {
    expect(proxyToAria2Options(enabledHttp)).toBeNull()
  })

  it('returns options when enabled and scope on', () => {
    const r = proxyToAria2Options({
      ...enabledHttp,
      scopes: { download: true, updateApp: false, updateTrackers: false },
    })
    expect(r).toEqual({ allProxy: 'http://p.example.com:8080', noProxy: '' })
  })

  it('does not pass socks5 to aria2', () => {
    expect(
      proxyToAria2Options({
        ...enabledHttp,
        protocol: 'socks5',
        scopes: { download: true, updateApp: false, updateTrackers: false },
      })
    ).toBeNull()
  })

  it('joins bypass with comma', () => {
    const r = proxyToAria2Options({
      ...enabledHttp,
      scopes: { download: true, updateApp: false, updateTrackers: false },
      bypass: ['localhost', '127.0.0.1'],
    })
    expect(r?.noProxy).toBe('localhost,127.0.0.1')
  })

  it('encodes credentials', () => {
    const r = proxyToAria2Options({
      ...enabledHttp,
      user: 'a@b',
      password: 'p:s',
      scopes: { download: true, updateApp: false, updateTrackers: false },
    })
    expect(r?.allProxy).toBe('http://a%40b:p%3As@p.example.com:8080')
  })

  it('brackets an IPv6 proxy host', () => {
    const r = proxyToAria2Options({
      ...enabledHttp,
      host: '2001:db8::1',
      scopes: { download: true, updateApp: false, updateTrackers: false },
    })
    expect(r?.allProxy).toBe('http://[2001:db8::1]:8080')
  })

  it('rejects control characters at the serialization boundary', () => {
    expect(
      proxyToAria2Options({
        ...enabledHttp,
        bypass: ['localhost\nhttp-proxy=http://evil'],
        scopes: { download: true, updateApp: false, updateTrackers: false },
      })
    ).toBeNull()
    expect(
      proxyToAria2Options({
        ...enabledHttp,
        user: 'user\nhttp-proxy=http://evil',
        scopes: { download: true, updateApp: false, updateTrackers: false },
      })
    ).toBeNull()
  })
})

describe('proxyToElectronConfig', () => {
  it('returns null when scope off', () => {
    expect(proxyToElectronConfig(enabledHttp)).toBeNull()
  })

  it('emits proxyRules with HTTP url', () => {
    const r = proxyToElectronConfig({
      ...enabledHttp,
      scopes: { download: false, updateApp: true, updateTrackers: false },
    })
    expect(r?.proxyRules).toBe('http://p.example.com:8080')
  })

  it('prefixes socks5 in proxyRules', () => {
    const r = proxyToElectronConfig({
      ...enabledHttp,
      protocol: 'socks5',
      scopes: { download: false, updateApp: true, updateTrackers: false },
    })
    expect(r?.proxyRules).toBe('socks5=socks5://p.example.com:8080')
  })
})

describe('proxyToDownloadRequestOptions', () => {
  it('returns null outside the enabled download scope', () => {
    expect(proxyToDownloadRequestOptions(DEFAULT_PROXY_SETTINGS)).toBeNull()
    expect(proxyToDownloadRequestOptions(enabledHttp)).toBeNull()
  })

  it('keeps the current proxy credentials and bypass only in request memory', () => {
    expect(
      proxyToDownloadRequestOptions({
        ...enabledHttp,
        protocol: 'socks5',
        user: 'a@b',
        password: 'p:s',
        bypass: ['localhost', '127.0.0.0/8'],
        scopes: { download: true, updateApp: false, updateTrackers: false },
      })
    ).toEqual({
      proxy: 'socks5://a%40b:p%3As@p.example.com:8080',
      noProxy: 'localhost,127.0.0.0/8',
    })
  })
})

describe('proxyToFetchUrl', () => {
  it('returns null when scope off', () => {
    expect(proxyToFetchUrl(enabledHttp)).toBeNull()
  })

  it('returns url when enabled and scope on', () => {
    expect(
      proxyToFetchUrl({
        ...enabledHttp,
        scopes: { download: false, updateApp: false, updateTrackers: true },
      })
    ).toBe('http://p.example.com:8080')
  })
})
