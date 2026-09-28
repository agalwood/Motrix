import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDownloadDirectories } from '@core/bridge-receiver/download-directories'
import { ErrorCodes } from '@motrix/mdxp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServerDownloadPathPolicy } from './download-path-policy'

describe('extension directory allowlist', () => {
  let root: string
  let settings: {
    defaultSaveDir: string
    directoryPreferences: { favorites: string[]; recent: string[] }
  }
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'mdxp-directories-')))
    settings = {
      defaultSaveDir: root,
      directoryPreferences: { favorites: [], recent: [] },
    }
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })
  it('filters missing paths, files and duplicate canonical aliases', async () => {
    await mkdir(join(root, 'favorite'))
    await symlink(join(root, 'favorite'), join(root, 'alias'))
    await writeFile(join(root, 'file'), 'data')
    settings.directoryPreferences.favorites = [
      join(root, 'favorite'),
      join(root, 'alias'),
      join(root, 'missing'),
      join(root, 'file'),
    ]
    const directories = createDownloadDirectories({
      getSettings: () => settings,
    })
    expect(await directories.list()).toEqual({
      defaultSaveDir: root,
      favorites: [join(root, 'favorite')],
      recent: [],
    })
    await expect(
      directories.resolveSelection(join(root, 'favorite'))
    ).resolves.toBe(join(root, 'favorite'))
  })
  it('rejects removed, arbitrary and unavailable choices before any task is created', async () => {
    await mkdir(join(root, 'favorite'))
    settings.directoryPreferences.favorites = [join(root, 'favorite')]
    const authorizeDirectory = vi.fn(async (path: string) => realpath(path))
    const directories = createDownloadDirectories({
      getSettings: () => settings,
      authorizeDirectory,
    })
    await directories.list()
    settings.directoryPreferences.favorites = []
    for (const path of [
      join(root, 'favorite'),
      '/private/secret',
      '../escape',
    ]) {
      authorizeDirectory.mockClear()
      await expect(directories.resolveSelection(path)).rejects.toMatchObject({
        code: ErrorCodes.InvalidParams,
        data: { appCode: 'download-directory-unavailable' },
      })
      expect(authorizeDirectory).not.toHaveBeenCalledWith(path)
    }
    await rm(root, { recursive: true })
    expect((await directories.list()).defaultSaveDir).toBeNull()
  })
  it('reuses Server allowed roots and blocks symlink escapes on listing and submission', async () => {
    const allowed = join(root, 'allowed')
    const outside = join(root, 'outside')
    await Promise.all([mkdir(allowed), mkdir(outside)])
    await symlink(outside, join(allowed, 'escape'))
    const policy = await createServerDownloadPathPolicy({
      defaultSaveDir: allowed,
      allowedSaveDirsValue: allowed,
    })
    settings.defaultSaveDir = allowed
    settings.directoryPreferences.favorites = [outside, join(allowed, 'escape')]
    const directories = createDownloadDirectories({
      getSettings: () => settings,
      authorizeDirectory: async (path) =>
        (await policy.authorizeDirectory(path)).canonicalPath,
    })
    expect(await directories.list()).toEqual({
      defaultSaveDir: allowed,
      favorites: [],
      recent: [],
    })
    await expect(directories.resolveSelection(outside)).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
    })
  })
})
