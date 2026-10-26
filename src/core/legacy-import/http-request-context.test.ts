// @vitest-environment node
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveLegacyHttpRequestContext } from './http-request-context'
import { digestBytes, parseLegacySession } from './session-parser'

const directory = path.resolve('/tmp/legacy-http-context')
const uri = 'https://example.com/file.bin'
const target = path.join(directory, 'file.bin')
function resolve(options = '', system: Record<string, unknown> = {}) {
  return resolveLegacyHttpRequestContext({
    session: Buffer.from(
      `magnet:?xt=urn:btih:1111111111111111111111111111111111111111\n gid=1111222233334444\n${uri}\n gid=0123456789abcdef\n dir=${directory}\n out=file.bin\n no-netrc=true\n${options}`
    ),
    system: Buffer.from(JSON.stringify({ dir: directory, ...system })),
    itemKey: 'gid:0123456789abcdef',
    uris: [uri],
    targetPath: target,
  })
}
describe('legacy HTTP request context', () => {
  it.each([true, false])(
    'ignores unrelated malformed HTTP paths when the selected task has GID: %s',
    (hasGid) => {
      const selected = `${uri}\n${hasGid ? ' gid=0123456789abcdef\n' : ''} dir=${directory}\n out=file.bin\n no-netrc=true\n`
      const context = resolveLegacyHttpRequestContext({
        session: Buffer.from(
          `https://example.com/%ZZ\n gid=ffffffffffffffff\nhttps://example.com/%ZZ\n${selected}`
        ),
        system: Buffer.from(JSON.stringify({ dir: directory })),
        uris: [uri],
        targetPath: target,
        itemKey: hasGid
          ? 'gid:0123456789abcdef'
          : `entry:${digestBytes(JSON.stringify(['http', target, [uri]]))}`,
      })
      expect(context.uri).toBe(uri)
    }
  )

  it('restores HTTP request fields while discarding old proxy settings', () => {
    const context = resolve(
      ' header=Cookie: session=secret\n referer=https://example.com/list\n http-user=user\n http-passwd=secret\n',
      {
        'all-proxy': 'http://proxy.example:8080',
        'all-proxy-user': 'proxy-user',
        'all-proxy-passwd': 'proxy-secret',
        'no-proxy': 'localhost',
        'user-agent': 'Legacy Browser',
      }
    )
    expect(context).toEqual({
      uri,
      headers: {
        cookie: 'session=secret',
        referer: 'https://example.com/list',
        authorization: `Basic ${Buffer.from('user:secret').toString('base64')}`,
      },
      proxy: '',
      noProxy: '',
      userAgent: 'Legacy Browser',
    })
  })
  it('keeps discarded proxy credentials out of the context and preview', () => {
    const options =
      ' all-proxy=http://private:secret@proxy.example:8080\n all-proxy-passwd=private-password\n'
    expect(resolve(options)).toMatchObject({ proxy: '', noProxy: '' })
    expect(
      JSON.stringify(parseLegacySession(Buffer.from(`${uri}\n${options}`)))
    ).not.toMatch(/private|secret|proxy\.example/)
  })
  it.each([
    ' load-cookies=/secret/cookies.txt\n',
    ' no-netrc=false\n',
    ' header=Authorization: a\n header=authorization: b\n',
    ' header=Proxy-Authorization: private\n',
    ' http-proxy=http://proxy.example:8080\n',
    ' referer=*\n',
    ' proxy-method=tunnel\n',
    ' on-download-complete=private-script\n',
  ])('discards unsupported settings before verification: %s', (options) => {
    expect(resolve(options)).toMatchObject({ headers: {}, proxy: '' })
  })
  it('leaves range and representation conditions owned by verification', () => {
    expect(
      resolve(
        ' header=Range: bytes=0-9\n header=If-Match: old\n header=Accept-Encoding: gzip\n'
      ).headers
    ).toEqual({})
  })
  it('combines distinct global and task headers as the original engine did', () => {
    expect(
      resolve(' header=Cookie: private\n', { header: ['X-Source: legacy'] })
        .headers
    ).toEqual({ 'x-source': 'legacy', cookie: 'private' })
  })
  it('discards a conflicting global and per-task header collection', () => {
    expect(
      resolve(' header=Cookie: changed\n', { header: ['Cookie: old'] }).headers
    ).toEqual({})
  })
  it('discards both protocol-specific legacy routes', () => {
    expect(
      resolve('', {
        'http-proxy': 'http://plain.example:8080',
        'https-proxy': 'http://secure.example:8081',
      }).proxy
    ).toBe('')
  })
  it('honors last singleton settings and an explicitly cleared task proxy', () => {
    expect(
      resolve(
        ' all-proxy=http://first.example:8080\n all-proxy=\n user-agent=first\n user-agent=last\n',
        { 'all-proxy': 'http://global.example:8080' }
      )
    ).toMatchObject({ proxy: '', userAgent: 'last' })
  })
  it('uses the migration stable key when the original session has no GID', () => {
    const context = resolveLegacyHttpRequestContext({
      session: Buffer.from(
        `${uri}\n dir=${directory}\n out=file.bin\n no-netrc=true\n`
      ),
      system: Buffer.from(JSON.stringify({ dir: directory })),
      uris: [uri],
      targetPath: target,
      itemKey: `entry:${digestBytes(JSON.stringify(['http', target, [uri]]))}`,
    })
    expect(context.uri).toBe(uri)
  })
})
