import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveDefaultSaveDirOptions } from './default-save-dir'

describe('resolveDefaultSaveDirOptions', () => {
  it.each([
    ['Windows known folder', 'D:\\Downloads'],
    ['macOS system folder', '/Volumes/Data/Downloads'],
    ['Linux XDG folder', '/mnt/data/Downloads'],
    ['Flatpak system folder', '/home/user/Downloads'],
  ])('uses the %s outside Snap', (_label, systemDownloadsDir) => {
    const getSystemDownloadsDir = vi.fn(() => systemDownloadsDir)
    const getHomeDir = vi.fn(() => '/home/user')
    const ensureDirectory = vi.fn()

    expect(
      resolveDefaultSaveDirOptions({
        snapEnvironment: null,
        getSystemDownloadsDir,
        getHomeDir,
        ensureDirectory,
      })
    ).toEqual({ defaultSaveDir: systemDownloadsDir })
    expect(getSystemDownloadsDir).toHaveBeenCalledOnce()
    expect(getHomeDir).not.toHaveBeenCalled()
    expect(ensureDirectory).not.toHaveBeenCalled()
  })

  it('creates a home Downloads fallback when the system folder is unavailable', () => {
    const getPathError = new Error("Failed to get 'downloads' path")
    const getSystemDownloadsDir = vi.fn(() => {
      throw getPathError
    })
    const getHomeDir = vi.fn(() => '/home/user')
    const ensureDirectory = vi.fn()
    const onSystemDownloadsDirError = vi.fn()

    expect(
      resolveDefaultSaveDirOptions({
        snapEnvironment: null,
        getSystemDownloadsDir,
        getHomeDir,
        ensureDirectory,
        onSystemDownloadsDirError,
      })
    ).toEqual({ defaultSaveDir: join('/home/user', 'Downloads') })
    expect(ensureDirectory).toHaveBeenCalledExactlyOnceWith(
      join('/home/user', 'Downloads')
    )
    expect(onSystemDownloadsDirError).toHaveBeenCalledExactlyOnceWith(
      getPathError,
      join('/home/user', 'Downloads')
    )
  })

  it('surfaces a failure to create the fallback directory', () => {
    const createError = new Error('permission denied')
    const onSystemDownloadsDirError = vi.fn()

    expect(() =>
      resolveDefaultSaveDirOptions({
        snapEnvironment: null,
        getSystemDownloadsDir: () => {
          throw new Error("Failed to get 'downloads' path")
        },
        getHomeDir: () => '/home/user',
        ensureDirectory: () => {
          throw createError
        },
        onSystemDownloadsDirError,
      })
    ).toThrow(createError)
    expect(onSystemDownloadsDirError).not.toHaveBeenCalled()
  })

  it('preserves the real home fallback and migration check for Snap', () => {
    const getSystemDownloadsDir = vi.fn(() => '/unused')
    const getHomeDir = vi.fn(() => '/unused')
    const ensureDirectory = vi.fn()
    const options = resolveDefaultSaveDirOptions({
      snapEnvironment: {
        instanceName: 'motrix',
        realHome: '/home/user',
      },
      getSystemDownloadsDir,
      getHomeDir,
      ensureDirectory,
    })

    expect(options.defaultSaveDir).toBe(join('/home/user', 'Downloads'))
    expect(
      options.isLegacyDefaultSaveDir?.(
        '/home/user/snap/motrix/current/Downloads'
      )
    ).toBe(true)
    expect(getSystemDownloadsDir).not.toHaveBeenCalled()
    expect(getHomeDir).not.toHaveBeenCalled()
    expect(ensureDirectory).not.toHaveBeenCalled()
  })
})
