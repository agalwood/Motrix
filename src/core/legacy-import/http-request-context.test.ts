// @vitest-environment node
import path from 'node:path'
import { extractAria2ProxyCredentials } from '@core/proxy/aria2-proxy-routing'
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

  it('restores only verified headers, referer, user agent, basic auth, and the effective proxy', () => {
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
      proxy: 'http://proxy-user:proxy-secret@proxy.example:8080/',
      noProxy: 'localhost',
      userAgent: 'Legacy Browser',
    })
  })
  it.each([
    ['proxy%40user', 'password%21'],
    ["代理@ user:/?#[]!$&'()*+,;=%", "密碼@ pass:/?#[]!$&'()*+,;=%"],
  ])(
    'preserves raw dedicated proxy credential bytes: %s',
    (username, password) => {
      const context = resolve('', {
        'all-proxy': 'http://proxy.example:8080',
        'all-proxy-user': username,
        'all-proxy-passwd': password,
      })
      expect(extractAria2ProxyCredentials(context.proxy)).toEqual({
        username,
        password,
      })
      expect(context.headers).toEqual({})
    }
  )
  it.each([
    {
      options: { 'all-proxy-user': 'new%40user' },
      expected: { username: 'new%40user', password: 'uri%21pass' },
    },
    {
      options: { 'all-proxy-passwd': 'new%21pass' },
      expected: { username: 'uri%40user', password: 'new%21pass' },
    },
    {
      options: { 'all-proxy-user': '' },
      expected: { username: '', password: '' },
    },
    {
      options: { 'all-proxy-passwd': '' },
      expected: { username: 'uri%40user', password: '' },
    },
  ])(
    'overrides only defined URI credential fields: $options',
    ({ options, expected }) => {
      const context = resolve('', {
        'all-proxy': 'http://uri%2540user:uri%2521pass@proxy.example:8080',
        ...options,
      })
      expect(extractAria2ProxyCredentials(context.proxy)).toEqual(expected)
    }
  )
  it('honors an explicitly empty task password over inherited credentials', () => {
    const context = resolve(' all-proxy-passwd=\n', {
      'all-proxy': 'http://uri-user:uri-pass@proxy.example:8080',
      'all-proxy-user': 'global%40user',
      'all-proxy-passwd': 'global-pass',
    })
    expect(extractAria2ProxyCredentials(context.proxy)).toEqual({
      username: 'global%40user',
      password: '',
    })
  })
  it('keeps reconstructed proxy credentials out of preview data', () => {
    const options =
      ' all-proxy=http://proxy.example:8080\n all-proxy-user=private%40user\n all-proxy-passwd=private%21password\n'
    expect(extractAria2ProxyCredentials(resolve(options).proxy)).toEqual({
      username: 'private%40user',
      password: 'private%21password',
    })
    const preview = JSON.stringify(
      parseLegacySession(Buffer.from(`${uri}\n${options}`))
    )
    expect(preview).not.toContain('private')
  })
  it.each(['private\npassword', 'private\ud800password'])(
    'rejects invalid credential text without exposing it',
    (password) => {
      expect(() =>
        resolve('', {
          'all-proxy': 'http://proxy.example:8080',
          'all-proxy-user': 'private-user',
          'all-proxy-passwd': password,
        })
      ).toThrow(/^legacyImport\.errors\.httpRequestUnsupported$/)
    }
  )
  it.each([
    ' load-cookies=/secret/cookies.txt\n',
    ' no-netrc=false\n',
    ' header=Authorization: a\n header=authorization: b\n',
    ' header=Proxy-Authorization: private\n',
    ' http-proxy=http://proxy.example:8080\n',
    ' referer=*\n',
  ])('rejects request contexts that cannot be mirrored: %s', (options) => {
    expect(() => resolve(options)).toThrow('httpRequestUnsupported')
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
  it('rejects a conflicting global and per-task header collection', () => {
    expect(() =>
      resolve(' header=Cookie: changed\n', { header: ['Cookie: old'] })
    ).toThrow('httpRequestUnsupported')
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
