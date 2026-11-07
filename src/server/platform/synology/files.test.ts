import { describe, expect, it } from 'vitest'
import { dsmDirectoryConfig, dsmPermission } from './files'

describe('DSM filesystem authority responses', () => {
  it('requires directory traversal and append rights, and a separate delete grant', () => {
    const acl = { read: true, write: true, exec: true, append: true, del: true }
    expect(dsmPermission(acl, 'writable', true)).toBe(true)
    expect(dsmPermission({ ...acl, exec: false }, 'writable', true)).toBe(false)
    expect(dsmPermission({ ...acl, append: false }, 'writable', true)).toBe(
      false
    )
    expect(dsmPermission({ ...acl, del: false }, 'deletable', false)).toBe(
      false
    )
    expect(dsmPermission({ ...acl, exec: false }, 'readable', true)).toBe(false)
  })
  it('does not treat empty grants, system paths, or a malformed volume as an unrestricted root', () => {
    for (const roots of [
      [],
      ['/'],
      ['/tmp/downloads'],
      ['/volume0/downloads'],
      ['/volume1'],
      ['/volume1/motrix/../other'],
      ['/volume1/motrix:/volume2/other'],
    ])
      expect(dsmDirectoryConfig.safeParse({ roots }).success).toBe(false)
    expect(
      dsmDirectoryConfig.safeParse({ roots: ['/volume1/downloads'] }).success
    ).toBe(true)
  })
})
