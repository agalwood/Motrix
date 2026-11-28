import { describe, expect, it } from 'vitest'
import { dsmScgiRequest, parseDsmScgiResponse } from './api'

const context = {
  cookie: 'id=synthetic',
  remoteAddress: '192.0.2.2',
  serverAddress: '192.0.2.1',
  serverPort: 5001,
  scheme: 'https' as const,
}
function decode(buffer: Buffer) {
  const colon = buffer.indexOf(':')
  const length = Number(buffer.subarray(0, colon).toString())
  const parts = buffer
    .subarray(colon + 1, colon + 1 + length)
    .toString()
    .split('\0')
    .slice(0, -1)
  return {
    env: Object.fromEntries(
      Array.from({ length: parts.length / 2 }, (_, i) =>
        parts.slice(i * 2, i * 2 + 2)
      )
    ),
    body: buffer.subarray(colon + length + 2).toString(),
  }
}
describe('fixed DSM SCGI bridge', () => {
  it('uses only the vendor bootstrap and read APIs, with secrets outside URI/argv', () => {
    const boot = decode(dsmScgiRequest(context, { kind: 'bootstrap' }))
    expect(boot.env.SCRIPT_FILENAME).toBe('/usr/syno/synoman/webman/login.cgi')
    expect(boot.body).toBe('')
    const req = decode(
      dsmScgiRequest(
        context,
        { kind: 'account', username: 'alice' },
        'synthetic-token'
      )
    )
    expect(req.env).toMatchObject({
      REMOTE_ADDR: '192.0.2.2',
      SERVER_PORT: '5001',
      HTTPS: 'on',
      HTTP_X_SYNO_TOKEN: 'synthetic-token',
      QUERY_STRING: '',
      REQUEST_URI: '/webapi/entry.cgi',
    })
    expect(new URLSearchParams(req.body).get('additional')).toBe('["expired"]')
    const file = decode(
      dsmScgiRequest(
        context,
        { kind: 'file', path: '/motrix/a,b' },
        'synthetic-token'
      )
    )
    expect(
      JSON.parse(new URLSearchParams(file.body).get('path') ?? '')
    ).toEqual(['/motrix/a,b'])
    expect(() =>
      dsmScgiRequest(
        { ...context, cookie: 'id=x\0REMOTE_USER\0root' },
        { kind: 'bootstrap' }
      )
    ).toThrow()
    expect(() =>
      dsmScgiRequest(
        context,
        { kind: 'file', path: '/motrix/../private' },
        'token'
      )
    ).toThrow()
    expect(() =>
      dsmScgiRequest(context, { kind: 'account', username: '--help' }, 'token')
    ).toThrow()
  })
  it('rejects truncated, ambiguous and non-JSON responses without retaining their content', () => {
    expect(
      parseDsmScgiResponse(
        Buffer.from('Content-Type: application/json\r\n\r\n{"success":false}')
      )
    ).toEqual({ success: false })
    for (const text of [
      'private-token',
      'Status: 302 Found\r\n\r\n{}',
      'Status: 200\r\nStatus: 500\r\n\r\n{}',
      'Content-Length: 99\r\n\r\n{}',
      'Content-Type: text/html\r\n\r\nprivate-token',
    ]) {
      let error: unknown
      try {
        parseDsmScgiResponse(Buffer.from(text))
      } catch (e) {
        error = e
      }
      expect(error).toBeInstanceOf(Error)
      expect(JSON.stringify(error)).not.toContain('private')
    }
  })
})
