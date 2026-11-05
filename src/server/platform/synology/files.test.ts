import { describe, expect, it } from 'vitest'
import { dsmDirectoryConfig, dsmPermission } from './files'

describe('DSM filesystem authority responses', () => {
  it('requires an effective ACL mask and directory traversal for read/write', () => {
    expect(
      dsmPermission('Final permission: [rwxpdDaARWcCo]\n', 'writable', true)
    ).toBe(true)
    expect(
      dsmPermission('Final permission: [rw-pdDaARWcCo]\n', 'writable', true)
    ).toBe(false)
    expect(
      dsmPermission('Final permission: [rwx-dDaARWcCo]', 'writable', true)
    ).toBe(false)
    expect(
      dsmPermission('Final permission: [r-x---a-R-c--]', 'deletable', false)
    ).toBe(false)
    for (const value of [
      '[0] user:alice:allow:rwxpdDaARWcCo:fd--',
      'rwxpdDaARWcCo',
      'Final permission: [ddddddddddddd]',
      'permission denied',
    ])
      expect(dsmPermission(value, 'deletable', false)).toBe(false)
  })
  it('does not treat empty grants, system paths, or a malformed volume as an unrestricted root', () => {
    for (const roots of [
      [],
      ['/'],
      ['/tmp/downloads'],
      ['/volume0/downloads'],
      ['/volume1'],
    ])
      expect(dsmDirectoryConfig.safeParse({ roots }).success).toBe(false)
    expect(
      dsmDirectoryConfig.safeParse({ roots: ['/volume1/downloads'] }).success
    ).toBe(true)
  })
})
