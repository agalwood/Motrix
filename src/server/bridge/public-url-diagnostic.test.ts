import { describe, expect, it } from 'vitest'
import {
  diagnoseMdxpPublicUrl,
  MdxpPublicUrlWarningReason,
} from './public-url-diagnostic'

describe('diagnoseMdxpPublicUrl', () => {
  it.each(['localhost', 'dev.localhost', '127.0.0.1', '127.42.0.9', '::1'])(
    'skips diagnostics for loopback MDXP host %s',
    (mdxpHost) => {
      expect(
        diagnoseMdxpPublicUrl({ mdxpHost, publicUrl: 'not a URL' })
      ).toBeUndefined()
    }
  )

  it.each([
    [undefined, MdxpPublicUrlWarningReason.NotSet],
    ['', MdxpPublicUrlWarningReason.Empty],
    ['   ', MdxpPublicUrlWarningReason.Empty],
    ['not a URL', MdxpPublicUrlWarningReason.Invalid],
    ['ftp://nas.example.test', MdxpPublicUrlWarningReason.UnsupportedProtocol],
  ])('reports unusable public URL %j', (publicUrl, reason) => {
    expect(diagnoseMdxpPublicUrl({ mdxpHost: '0.0.0.0', publicUrl })).toEqual({
      reason,
    })
  })

  it.each([
    ['http://localhost:8080/approve?token=secret', 'http://localhost:8080'],
    ['http://127.0.0.1:8080/approve', 'http://127.0.0.1:8080'],
    ['http://127.42.0.9:8080/approve', 'http://127.42.0.9:8080'],
    ['http://admin.localhost:8080/approve', 'http://admin.localhost:8080'],
    ['http://[::1]:8080/approve', 'http://[::1]:8080'],
  ])(
    'reports loopback public URL %s with only its origin',
    (publicUrl, origin) => {
      expect(diagnoseMdxpPublicUrl({ mdxpHost: '0.0.0.0', publicUrl })).toEqual(
        {
          reason: MdxpPublicUrlWarningReason.LoopbackHost,
          origin,
        }
      )
    }
  )

  it.each([
    ['http://0.0.0.0:8080/approve', 'http://0.0.0.0:8080'],
    ['http://[::]:8080/approve', 'http://[::]:8080'],
  ])('reports unspecified public URL %s', (publicUrl, origin) => {
    expect(diagnoseMdxpPublicUrl({ mdxpHost: '0.0.0.0', publicUrl })).toEqual({
      reason: MdxpPublicUrlWarningReason.UnspecifiedHost,
      origin,
    })
  })

  it('never includes credentials, path, or query in a reported origin', () => {
    expect(
      diagnoseMdxpPublicUrl({
        mdxpHost: '0.0.0.0',
        publicUrl:
          'http://operator:password@localhost:8080/approve?token=secret',
      })
    ).toEqual({
      reason: MdxpPublicUrlWarningReason.LoopbackHost,
      origin: 'http://localhost:8080',
    })
  })

  it.each([
    'http://192.168.1.20:8080',
    'http://nas.local:8080/approve',
    'https://downloads.example.test/approve?flow=device',
  ])('accepts remotely reachable HTTP(S) URL %s', (publicUrl) => {
    expect(
      diagnoseMdxpPublicUrl({ mdxpHost: '0.0.0.0', publicUrl })
    ).toBeUndefined()
  })
})
