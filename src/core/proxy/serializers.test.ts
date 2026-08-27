import { DEFAULT_PROXY_SETTINGS } from '@shared/schemas/proxy-settings'
import { describe, expect, it } from 'vitest'
import {
  proxyToAria2Options,
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
