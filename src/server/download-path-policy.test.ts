import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createServerDownloadPathPolicy,
  resolveServerDefaultSaveDir,
} from './download-path-policy'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-save-policy-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await chmod(root, 0o700).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    })
  )
})

describe('resolveServerDefaultSaveDir', () => {
  it('uses and normalizes MOTRIX_DEFAULT_SAVE_DIR', () => {
    expect(
      resolveServerDefaultSaveDir(
        { MOTRIX_DEFAULT_SAVE_DIR: '/downloads/../downloads' },
        '/fallback'
      )
    ).toBe('/downloads')
  })

  it('rejects a relative MOTRIX_DEFAULT_SAVE_DIR', () => {
    expect(() =>
      resolveServerDefaultSaveDir(
        { MOTRIX_DEFAULT_SAVE_DIR: 'downloads' },
        '/fallback'
      )
    ).toThrow('MOTRIX_DEFAULT_SAVE_DIR must be an absolute path')
  })
})

describe('ServerDownloadPathPolicy', () => {
  it('authorizes canonical aliases only within their configured resolved subtree, including restart defaults', async () => {
    const root = await tempRoot()
    const canonicalRoot = path.join(root, 'real')
    const alias = path.join(root, 'alias')
    await mkdir(canonicalRoot)
    await symlink(canonicalRoot, alias)
    const policy = await createServerDownloadPathPolicy({
      defaultSaveDir: alias,
      allowedSaveDirsValue: alias,
    })
    const prepared = await policy.prepareSaveDir(path.join(alias, 'child'))
    expect(await policy.authorizeDirectory(prepared)).toEqual({
      path: path.join(alias, 'child'),
      canonicalPath: prepared,
      rootPath: alias,
    })
    const restarted = await createServerDownloadPathPolicy({
      defaultSaveDir: prepared,
      allowedSaveDirsValue: alias,
    })
    expect(await restarted.prepareSaveDir(undefined)).toBe(prepared)
    await expect(restarted.authorizeDirectory(root)).rejects.toMatchObject({
      directoryCode: 'outsideRoots',
    })
    const outside = path.join(root, 'outside')
    await mkdir(outside)
    await symlink(outside, path.join(canonicalRoot, 'escape'))
    await expect(
      restarted.authorizeDirectory(path.join(canonicalRoot, 'escape'))
    ).rejects.toMatchObject({ directoryCode: 'outsideRoots' })
  })

  it('does not treat whitespace-only literal requests as the default sentinel', async () => {
    const root = await tempRoot()
    const policy = await createServerDownloadPathPolicy({
      defaultSaveDir: root,
    })
    await expect(policy.prepareSaveDir(' ')).rejects.toThrow(
      'must be an absolute path'
    )
    expect(await policy.prepareSaveDir('')).toBe(await realpath(root))
    const missing = path.join(root, 'absent')
    await expect(policy.authorizeDirectory(missing)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(realpath(missing)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('creates and prepares the default and allowed roots', async () => {
    const root = await tempRoot()
    const downloads = path.join(root, 'downloads')
    const media = path.join(root, 'media')
    const policy = await createServerDownloadPathPolicy({
      defaultSaveDir: downloads,
      allowedSaveDirsValue: [downloads, media].join(path.delimiter),
    })

    expect(policy.allowedSaveDirs).toEqual([downloads, media])
    await expect(policy.prepareSaveDir('')).resolves.toBe(
      await realpath(downloads)
    )
    const nested = await policy.prepareSaveDir(path.join(media, 'nested'))
    expect(nested).toBe(await realpath(path.join(media, 'nested')))
  })

  it('rejects an allowed root that does not contain the default', async () => {
    const root = await tempRoot()
    await expect(
      createServerDownloadPathPolicy({
        defaultSaveDir: path.join(root, 'downloads'),
        allowedSaveDirsValue: path.join(root, 'media'),
      })
    ).rejects.toThrow(
      'MOTRIX_DEFAULT_SAVE_DIR must be inside MOTRIX_ALLOWED_SAVE_DIRS'
    )
  })

  it('rejects relative and out-of-root task paths before creating them', async () => {
    const root = await tempRoot()
    const downloads = path.join(root, 'downloads')
    const escaped = path.join(root, 'escaped')
    const policy = await createServerDownloadPathPolicy({
      defaultSaveDir: downloads,
      allowedSaveDirsValue: downloads,
    })

    await expect(policy.prepareSaveDir('relative')).rejects.toThrow(
      'Save directory must be an absolute path'
    )
    await expect(policy.prepareSaveDir(escaped)).rejects.toThrow(
      'Save directory is outside MOTRIX_ALLOWED_SAVE_DIRS'
    )
    await expect(realpath(escaped)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a symlink that escapes an allowed root', async () => {
    const root = await tempRoot()
    const downloads = path.join(root, 'downloads')
    const outside = path.join(root, 'outside')
    await Promise.all([
      mkdir(downloads, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ])
    await symlink(outside, path.join(downloads, 'escape'))
    const policy = await createServerDownloadPathPolicy({
      defaultSaveDir: downloads,
      allowedSaveDirsValue: downloads,
    })

    await expect(
      policy.prepareSaveDir(path.join(downloads, 'escape', 'nested'))
    ).rejects.toThrow('Save directory resolves outside the allowed root')
  })

  it('permits any absolute writable path when no allowlist is configured', async () => {
    const root = await tempRoot()
    const downloads = path.join(root, 'downloads')
    const custom = path.join(root, 'custom')
    const policy = await createServerDownloadPathPolicy({
      defaultSaveDir: downloads,
    })

    expect(policy.allowedSaveDirs).toEqual([])
    const prepared = await policy.prepareSaveDir(custom)
    expect(prepared).toBe(await realpath(custom))
  })

  it('surfaces an unwritable save directory clearly', async () => {
    const root = await tempRoot()
    const downloads = path.join(root, 'downloads')
    await mkdir(downloads, { recursive: true })
    await chmod(downloads, 0o500)

    await expect(
      createServerDownloadPathPolicy({ defaultSaveDir: downloads })
    ).rejects.toThrow('Save directory is not writable')
    await chmod(downloads, 0o700)
  })
})
