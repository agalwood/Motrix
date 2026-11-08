// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  type Aria2OutputRecord,
  Aria2ProcessOutput,
} from './aria2-process-output'

function capture(stream: 'stdout' | 'stderr' = 'stdout') {
  const records: Aria2OutputRecord[] = []
  const reader = new Aria2ProcessOutput(
    stream,
    (record) => records.push(record),
    (text) => text.replaceAll('private-rpc-secret', '<redacted>')
  )
  return { reader, records }
}

function failure(status: number, separator = '\n') {
  return [
    '10/14 00:09:21 [\u001b[1;31mERROR\u001b[0m] CUID#17 - Download aborted. URI=https://user:password@cdn.example/private-path?unknown=signed-value#fragment',
    'Exception: [AbstractCommand.cc:351] errorCode=22 URI=https://cdn.example/private-path?unknown=signed-value',
    `  -> [HttpSkipResponseCommand.cc:240] errorCode=22 The response status is not successful. status=${status}`,
    '',
  ].join(separator)
}

describe('Aria2ProcessOutput', () => {
  it.each([403, 416, 429])(
    'retains HTTP %s and its connection at error level',
    (status) => {
      const { reader, records } = capture()
      reader.write(Buffer.from(failure(status)))
      expect(records).toHaveLength(3)
      expect(records.every((record) => record.level === 'error')).toBe(true)
      expect(records[2]).toMatchObject({
        message: 'aria2 engine diagnostic',
        fields: {
          stream: 'stdout',
          cuid: '17',
          aria2ErrorCode: 22,
          httpStatus: status,
        },
      })
      const serialized = JSON.stringify(records)
      for (const secret of [
        'password',
        'private-path',
        'signed-value',
        'fragment',
        '\\u001b',
      ]) {
        expect(serialized).not.toContain(secret)
      }
      expect(records[0].fields.data).toContain('https://cdn.example/[redacted]')
    }
  )

  it.each(['\n', '\r\n'])(
    'handles every byte boundary and %j line endings',
    (separator) => {
      const input = Buffer.from(failure(403, separator))
      const expected = capture()
      expected.reader.write(input)
      expected.reader.end()
      for (let offset = 1; offset < input.length; offset += 1) {
        const actual = capture()
        actual.reader.write(input.subarray(0, offset))
        actual.reader.write(input.subarray(offset))
        actual.reader.end()
        expect(actual.records).toEqual(expected.records)
      }
      expect(expected.records[2].fields.cuid).toBe('17')
    }
  )

  it('decodes UTF-8 across byte boundaries and flushes the last line once', () => {
    const { reader, records } = capture()
    for (const byte of Buffer.from('10/14 00:09:21 [WARN] 磁盘写入失败')) {
      reader.write(Buffer.from([byte]))
    }
    expect(records).toHaveLength(0)
    reader.end()
    reader.end()
    reader.write(Buffer.from('ignored'))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      level: 'warn',
      fields: { data: '10/14 00:09:21 [WARN] 磁盘写入失败' },
    })
  })

  it('keeps progress and ordinary notices out of production logs', () => {
    const { reader, records } = capture()
    reader.write(
      Buffer.from(
        [
          '[#123456 31MiB/32MiB(99%) CN:1 DL:0B]\r',
          '10/14 00:09:21 [NOTICE] Download complete\n',
          '10/14 00:09:21 [INFO] RPC-DIAG CUID#7 queue ready\n',
          '10/14 00:09:21 [DEBUG] ordinary engine detail\n',
        ].join('')
      )
    )
    expect(records.map((record) => record.level)).toEqual([
      'debug',
      'debug',
      'info',
      'debug',
    ])
    expect(records[2].message).toBe('aria2 RPC diagnostic')
  })

  it('does not attach a previous connection to a later unrelated exception', () => {
    const { reader, records } = capture()
    reader.write(
      Buffer.from(
        `${failure(403)}\nException: [CreateRequestCommand.cc:108] errorCode=22 No URI available.\n`
      )
    )
    expect(records.at(-1)?.fields).not.toHaveProperty('cuid')
    expect(records.at(-1)?.fields).not.toHaveProperty('httpStatus')
    expect(records.at(-1)?.level).toBe('error')
  })

  it('keeps independently interleaved stdout and stderr contexts separate', () => {
    const out = capture()
    const err = capture('stderr')
    out.reader.write(Buffer.from('10/14 00:09:21 [ERROR] CUID#7 failed\n'))
    err.reader.write(Buffer.from('10/14 00:09:21 [WARN] CUID#8 failed\n'))
    out.reader.write(
      Buffer.from('Exception: [source:1] errorCode=22 status=403\n')
    )
    err.reader.write(Buffer.from('Exception: [source:1] errorCode=2 Timeout\n'))
    expect(out.records[1]).toMatchObject({
      level: 'error',
      fields: { cuid: '7', httpStatus: 403 },
    })
    expect(err.records[1]).toMatchObject({
      level: 'warn',
      fields: { cuid: '8', aria2ErrorCode: 2 },
    })
  })

  it('redacts headers, folded credentials, known secrets and signed URL paths', () => {
    const { reader, records } = capture('stderr')
    const text = [
      'Cookie: session=private-cookie',
      ' folded-cookie-secret',
      'Authorization: Basic private-basic',
      'Set-Cookie: private-set-cookie',
      'X-Provider-Token: private-header',
      'Provider-Credential: custom-private-header',
      'Referer: https://example.com/private-referer',
      'failure Bearer private-bearer',
      'failure --rpc-secret=private-rpc-secret',
      'failure https://alice:private-pass@cdn.example/private-url-path?newKey=private-query',
      '',
    ].join('\n')
    for (const byte of Buffer.from(text)) reader.write(Buffer.from([byte]))
    const serialized = JSON.stringify(records)
    expect(serialized).not.toContain('private')
    expect(serialized).not.toContain('alice')
    expect(records.every((record) => record.level === 'warn')).toBe(true)
  })

  it('omits oversized lines entirely and recovers at the next separator', () => {
    const { reader, records } = capture()
    reader.write(Buffer.from('https://cdn.example/'))
    for (let index = 0; index < 100; index += 1) {
      reader.write(Buffer.from('private-segment'.repeat(100)))
    }
    reader.write(Buffer.from('private-suffix\n'))
    reader.write(Buffer.from(failure(429)))
    expect(records).toHaveLength(4)
    expect(records[0].message).toBe('aria2 output truncated')
    expect(JSON.stringify(records)).not.toContain('private')
    expect(records.at(-1)?.fields.httpStatus).toBe(429)
  })

  it('flushes an oversized unterminated line without emitting its contents', () => {
    const { reader, records } = capture('stderr')
    reader.write(Buffer.from('secret'.repeat(10_000)))
    reader.end()
    expect(records).toHaveLength(1)
    expect(records[0].fields.data).toContain('omitted')
    expect(records[0].fields.data).not.toContain('secret')
  })

  it('retains native startup diagnostics with a colon prefix', () => {
    const { reader, records } = capture('stderr')
    reader.write(
      Buffer.from(
        'aria2c: unrecognized option --broken\nSQLite3: database is locked\n'
      )
    )
    expect(records.map((record) => record.fields.data)).toEqual([
      'aria2c: unrecognized option --broken',
      'SQLite3: database is locked',
    ])
  })

  it('redacts raw HTTP targets and arbitrary header blocks without consuming later errors', () => {
    const { reader, records } = capture()
    reader.write(
      Buffer.from(
        [
          'GET /private-path?key=private-query HTTP/1.1',
          'Provider-Session: private-session',
          ' folded-private-value',
          '',
          'HTTP/1.1 403 Forbidden',
          'Unusual-Auth-Header: private-auth',
          '',
          failure(403),
        ].join('\r\n')
      )
    )
    expect(JSON.stringify(records)).not.toContain('private')
    expect(records.at(-1)).toMatchObject({
      level: 'error',
      fields: { cuid: '17', httpStatus: 403 },
    })
  })
})
