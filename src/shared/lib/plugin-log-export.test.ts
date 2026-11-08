import { describe, expect, it } from 'vitest'
import { serializePluginLogsForExport } from './plugin-log-export'

describe('plugin log export', () => {
  it('redacts verbose structured fields and embedded URLs without changing the live entries', () => {
    const entries = [
      {
        ts: 123,
        level: 'info' as const,
        msg: 'GET https://example.com/download?id=private-id&token=secret',
        uris: [
          'https://user:pass@example.com/download?id=private-id&sig=secret#private',
        ],
        nested: {
          detail: 'redirect https://example.com/?unknown=opaque&flag&empty=',
          token: 'nested-secret',
          signature: 'nested-signature',
          code: 'ETIMEDOUT',
        },
        headers: {
          Cookie: 'session=cookie-secret',
          Authorization: 'Bearer auth-secret',
        },
        body: 'private-body',
        filepath: '/Users/alice/private/file.txt',
        stage: 'engine.dispatch',
        taskId: 'task-1',
      },
    ]
    const original = structuredClone(entries)
    const output = serializePluginLogsForExport(entries)
    const [entry] = JSON.parse(output)
    expect(entry).toMatchObject({
      ts: 123,
      level: 'info',
      taskId: 'task-1',
      stage: 'engine.dispatch',
    })
    expect(entry.msg).toBe(
      'GET https://example.com/download?id=[redacted]&token=[redacted]'
    )
    expect(entry.uris).toEqual([
      'https://example.com/download?id=[redacted]&sig=[redacted]',
    ])
    expect(entry.nested.detail).toBe(
      'redirect https://example.com/?unknown=[redacted]&[redacted]&empty=[redacted]'
    )
    expect(entry.nested.signature).toBe('[redacted]')
    expect(entry.nested.code).toBe('ETIMEDOUT')
    expect(entry).not.toHaveProperty('headers')
    expect(entry).not.toHaveProperty('body')
    for (const secret of [
      'private-id',
      'secret',
      'opaque',
      'user:pass',
      '/Users/alice',
    ])
      expect(output).not.toContain(secret)
    expect(entries).toEqual(original)
  })
})
