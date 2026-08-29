import { describe, expect, it } from 'vitest'
import { DEFAULT_PROXY_SETTINGS, proxySettingsSchema } from './proxy-settings'

describe('proxySettingsSchema', () => {
  it('parses an empty object to defaults', () => {
    expect(proxySettingsSchema.parse({})).toEqual(DEFAULT_PROXY_SETTINGS)
  })

  it('defaults to disabled', () => {
    expect(DEFAULT_PROXY_SETTINGS.enabled).toBe(false)
  })

  it('defaults all scopes to false', () => {
    expect(DEFAULT_PROXY_SETTINGS.scopes).toEqual({
      download: false,
      updateApp: false,
      updateTrackers: false,
    })
  })

  it('catches invalid protocol back to http', () => {
    expect(proxySettingsSchema.parse({ protocol: 'sftp' }).protocol).toBe(
      'http'
    )
  })

  it('catches port out of range', () => {
    expect(proxySettingsSchema.parse({ port: -1 }).port).toBe(8080)
    expect(proxySettingsSchema.parse({ port: 70000 }).port).toBe(8080)
  })

  it('preserves valid values', () => {
    const r = proxySettingsSchema.parse({
      enabled: true,
      protocol: 'socks5',
      host: 'example.com',
      port: 1080,
    })
    expect(r).toMatchObject({
      enabled: true,
      protocol: 'socks5',
      host: 'example.com',
      port: 1080,
    })
  })

  it('preserves the download scope for socks5', () => {
    const r = proxySettingsSchema.parse({
      protocol: 'socks5',
      scopes: { download: true },
    })
    expect(r.scopes.download).toBe(true)
  })

  it('truncates bypass list past max via fallback', () => {
    const long = Array.from({ length: 100 }, (_, i) => `host${i}`)
    expect(proxySettingsSchema.parse({ bypass: long }).bypass).toEqual([])
  })

  it('drops proxy fields and bypass lists containing control characters', () => {
    const parsed = proxySettingsSchema.parse({
      host: 'proxy.example\nhttp-proxy=evil',
      user: 'user\rname',
      password: 'pass\u007fword',
      bypass: ['localhost', 'safe\nhttp-proxy=evil'],
    })

    expect(parsed.host).toBe('')
    expect(parsed.user).toBe('')
    expect(parsed.password).toBe('')
    expect(parsed.bypass).toEqual([])
  })

  it('parses partial scopes', () => {
    const r = proxySettingsSchema.parse({
      scopes: { download: true },
    })
    expect(r.scopes).toEqual({
      download: true,
      updateApp: false,
      updateTrackers: false,
    })
  })
})
