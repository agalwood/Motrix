import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SynologyAccounts } from './accounts'
import { dsmDirectoryConfig, dsmPermission, SynologyFileAccess } from './files'

describe('DSM filesystem authority responses', () => {
  it.skipIf(process.platform === 'win32')(
    'refuses a replaced live grants document before checking any share',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'motrix-synology-grants-'))
      try {
        const grants = path.join(dir, 'directories.json'),
          target = path.join(dir, 'fixture')
        await writeFile(
          target,
          JSON.stringify({ roots: ['/volume1/motrix'] }),
          { mode: 0o600 }
        )
        await symlink(target, grants)
        const files = new SynologyFileAccess(grants, new SynologyAccounts())
        await expect(files.authorizedRoots()).rejects.toMatchObject({
          code: 'ELOOP',
        })
        await rm(grants)
        await writeFile(grants, 'private-test-content', { mode: 0o600 })
        await expect(files.authorizedRoots()).rejects.toThrow(
          /^Invalid DSM directory configuration$/
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )
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
