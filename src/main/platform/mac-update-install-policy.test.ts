import { statSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getMacUpdateInstallBlockReason } from './mac-update-install-policy'

vi.mock('node:fs', () => ({ statSync: vi.fn() }))

const context = {
  platform: 'darwin' as const,
  isPackaged: true,
  execPath: '/Users/test/Applications/Motrix.app/Contents/MacOS/Motrix',
  temporaryDirectory: '/private/var/folders/test/T',
}
const directory = (dev: number) =>
  ({ dev, isDirectory: () => true }) as ReturnType<typeof statSync>

beforeEach(() => {
  vi.mocked(statSync).mockReset().mockReturnValue(directory(1))
})

describe('getMacUpdateInstallBlockReason', () => {
  it.each([
    '/Applications/Motrix.app/Contents/MacOS/Motrix',
    '/Users/test/Applications/Motrix.app/Contents/MacOS/Motrix',
    '/Users/test/Other Apps/Motrix.app/Contents/MacOS/Motrix',
    '/Volumes/Alias/Motrix.app/Contents/MacOS/Motrix',
  ])('allows the same filesystem regardless of the path: %s', (execPath) => {
    expect(
      getMacUpdateInstallBlockReason({ ...context, execPath })
    ).toBeUndefined()
  })

  it('blocks a different filesystem even without a /Volumes prefix', () => {
    vi.mocked(statSync).mockImplementation((location) =>
      directory(location === context.temporaryDirectory ? 1 : 2)
    )
    expect(getMacUpdateInstallBlockReason(context)).toBe('cross-volume')
  })

  it('blocks a bundle mounted separately from its parent', () => {
    vi.mocked(statSync)
      .mockReturnValueOnce(directory(1))
      .mockReturnValueOnce(directory(2))
    expect(getMacUpdateInstallBlockReason(context)).toBe('cross-volume')
  })

  it('fails closed when the bundle or temporary directory is unavailable', () => {
    vi.mocked(statSync).mockImplementation(() => {
      throw new Error('EACCES')
    })
    expect(getMacUpdateInstallBlockReason(context)).toBe('location-unavailable')
  })

  it('does not infer a bundle from an unexpected executable layout', () => {
    expect(
      getMacUpdateInstallBlockReason({
        ...context,
        execPath: '/usr/bin/motrix',
      })
    ).toBe('location-unavailable')
    expect(statSync).not.toHaveBeenCalled()
  })

  it.each([
    { platform: 'win32' as const, isPackaged: true },
    { platform: 'linux' as const, isPackaged: true },
    { platform: 'darwin' as const, isPackaged: false },
  ])('does not inspect other platforms or development runs: %j', (override) => {
    expect(
      getMacUpdateInstallBlockReason({ ...context, ...override })
    ).toBeUndefined()
    expect(statSync).not.toHaveBeenCalled()
  })
})
