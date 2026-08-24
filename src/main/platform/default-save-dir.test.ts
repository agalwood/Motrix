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

    expect(
      resolveDefaultSaveDirOptions({
        snapEnvironment: null,
        getSystemDownloadsDir,
      })
    ).toEqual({ defaultSaveDir: systemDownloadsDir })
    expect(getSystemDownloadsDir).toHaveBeenCalledOnce()
  })

  it('preserves the real home fallback and migration check for Snap', () => {
    const getSystemDownloadsDir = vi.fn(() => '/unused')
    const options = resolveDefaultSaveDirOptions({
      snapEnvironment: {
        instanceName: 'motrix',
        realHome: '/home/user',
      },
      getSystemDownloadsDir,
    })

    expect(options.defaultSaveDir).toBe(join('/home/user', 'Downloads'))
    expect(
      options.isLegacyDefaultSaveDir?.(
        '/home/user/snap/motrix/current/Downloads'
      )
    ).toBe(true)
    expect(getSystemDownloadsDir).not.toHaveBeenCalled()
  })
})
