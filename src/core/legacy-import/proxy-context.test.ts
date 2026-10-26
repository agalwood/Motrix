// @vitest-environment node
import { extractAria2ProxyCredentials } from '@core/proxy/aria2-proxy-routing'
import { describe, expect, it } from 'vitest'
import { resolveLegacyProxyOptions } from './proxy-context'
import {
  parseLegacySession,
  resolveLegacyRequestSettings,
} from './session-parser'

const uri =
  'magnet:?xt=urn:btih:1111111111111111111111111111111111111111&dn=example'

describe('legacy proxy context', () => {
  it.each(['all-proxy', 'http-proxy', 'https-proxy', 'ftp-proxy'])(
    'preserves native endpoint semantics after filtering %s',
    (key) => {
      const entry = parseLegacySession(
        Buffer.from(`${uri}\n ${key}=ftp://old%40user:secret@proxy.example\n`)
      )[0]
      const settings = resolveLegacyRequestSettings(entry, {}, 'magnet')
      const proxy = resolveLegacyProxyOptions(settings.values)
      expect(settings.ignoredOptions).not.toContain(key)
      const property = {
        'all-proxy': 'allProxy',
        'http-proxy': 'httpProxy',
        'https-proxy': 'httpsProxy',
        'ftp-proxy': 'ftpProxy',
      } as const
      expect(proxy[property[key as keyof typeof property]]).toBe(
        'http://old%40user:secret@proxy.example:21/'
      )
    }
  )
  it('returns an explicit route for every native field, including unset fields', () => {
    expect(resolveLegacyProxyOptions({})).toEqual({
      allProxy: '',
      httpProxy: '',
      httpsProxy: '',
      ftpProxy: '',
      noProxy: '',
      proxyMethod: 'get',
    })
  })

  it('keeps protocol-specific routes and tunnel mode without conflating them', () => {
    const entry = parseLegacySession(
      Buffer.from(
        `${uri}\n gid=0123456789abcdef\n http-proxy=http://task.example:9000\n proxy-method=tunnel\n`
      )
    )[0]
    const context = resolveLegacyProxyOptions(
      resolveLegacyRequestSettings(
        entry,
        {
          'all-proxy': 'all.example:8000',
          'http-proxy': 'old.example:8080',
          'https-proxy': 'secure.example:8001',
          'ftp-proxy': 'ftp.example:8002',
          'no-proxy': 'localhost',
        },
        'magnet'
      ).values
    )
    expect(context).toEqual({
      allProxy: 'http://all.example:8000/',
      httpProxy: 'http://task.example:9000/',
      httpsProxy: 'http://secure.example:8001/',
      ftpProxy: 'http://ftp.example:8002/',
      noProxy: 'localhost',
      proxyMethod: 'tunnel',
    })
  })

  it.each([
    [
      { 'all-proxy-user': ['raw%40user'] },
      { username: 'raw%40user', password: 'uri%pass' },
    ],
    [
      { 'all-proxy-passwd': ['raw%40pass'] },
      { username: 'uri%user', password: 'raw%40pass' },
    ],
    [{ 'all-proxy-user': [''] }, { username: '', password: '' }],
    [{ 'all-proxy-passwd': [''] }, { username: 'uri%user', password: '' }],
  ])(
    'overrides only defined raw credential fields once: %j',
    (values, expected) => {
      const result = resolveLegacyProxyOptions({
        'all-proxy': ['http://uri%25user:uri%25pass@proxy.example:8080'],
        ...values,
      })
      expect(extractAria2ProxyCredentials(result.allProxy)).toEqual(expected)
    }
  )

  it('uses the final task singleton and empty task values over global proxy settings', () => {
    const entry = parseLegacySession(
      Buffer.from(
        `${uri}\n all-proxy=http://first.example:80\n all-proxy=\n no-proxy=\n`
      )
    )[0]
    const merged = resolveLegacyRequestSettings(
      entry,
      { 'all-proxy': 'http://global.example:8080', 'no-proxy': 'localhost' },
      'magnet'
    )
    expect(resolveLegacyProxyOptions(merged.values)).toMatchObject({
      allProxy: '',
      noProxy: '',
    })
  })
})
