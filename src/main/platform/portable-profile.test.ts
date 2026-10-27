import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  statSync: vi.fn((): { isDirectory: () => boolean } => ({
    isDirectory: () => true,
  })),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}))
vi.mock('node:fs', () => fs)

import {
  preparePortableProfile,
  resolvePortableProfile,
  setPortableProfile,
} from './portable-profile'

const options = {
  platform: 'win32' as const,
  isPackaged: true,
  isWindowsPackage: false,
  executablePath: 'E:\\测试 Motrix\\Motrix.exe',
}

describe('portable profile selection', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => setPortableProfile(null))
  it('uses the executable location, including spaces and Unicode, independently of cwd', () => {
    expect(resolvePortableProfile(options)).toMatchObject({
      root: 'E:\\测试 Motrix',
      userDataDir: 'E:\\测试 Motrix\\data\\user-data',
      downloadsDir: 'E:\\测试 Motrix\\Downloads',
    })
  })
  it.each([
    { platform: 'darwin' as const },
    { platform: 'linux' as const },
    { isPackaged: false },
    { isWindowsPackage: true },
  ])(
    'never inspects a portable directory for excluded runtimes: %o',
    (override) => {
      expect(resolvePortableProfile({ ...options, ...override })).toBeNull()
      expect(fs.statSync).not.toHaveBeenCalled()
    }
  )
  it('leaves installed NSIS apps unchanged even with a data directory', () => {
    fs.existsSync.mockReturnValueOnce(true)
    expect(resolvePortableProfile(options)).toBeNull()
    expect(fs.statSync).not.toHaveBeenCalled()
  })
  it('does not enable or create a portable directory when it is absent', () => {
    fs.statSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
    expect(resolvePortableProfile(options)).toBeNull()
    expect(fs.mkdirSync).not.toHaveBeenCalled()
  })
  it('fails closed for an unreadable marker or a file named data', () => {
    fs.statSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    })
    expect(() => resolvePortableProfile(options)).toThrow('unavailable')
    fs.statSync.mockReturnValueOnce({ isDirectory: () => false })
    expect(() => resolvePortableProfile(options)).toThrow('unavailable')
  })
  it('probes writes and never falls back when the portable device is read-only', () => {
    const profile = resolvePortableProfile(options)!
    fs.writeFileSync.mockImplementationOnce(() => {
      throw new Error('read-only')
    })
    expect(() => preparePortableProfile(profile)).toThrow('not writable')
  })
})
