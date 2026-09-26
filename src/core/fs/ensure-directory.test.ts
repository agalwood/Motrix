import type { Stats } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureDirectory } from './ensure-directory'

vi.mock('node:fs/promises', () => {
  const fs = { mkdir: vi.fn(), stat: vi.fn() }
  return { ...fs, default: fs }
})

beforeEach(() => {
  vi.resetAllMocks()
})

describe('ensureDirectory', () => {
  it.each([
    'D:\\',
    'D:/',
    '\\\\server\\share',
    '\\\\server\\share\\',
    '\\\\?\\D:\\',
    '\\\\?\\UNC\\server\\share\\',
    '/',
    '/mnt/nfs/downloads',
  ])('accepts an existing directory without mkdir: %s', async (directory) => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as Stats)
    vi.mocked(mkdir).mockRejectedValue(
      Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    )

    await ensureDirectory(directory)

    expect(stat).toHaveBeenCalledWith(directory)
    expect(mkdir).not.toHaveBeenCalled()
  })

  it('creates a missing nested directory recursively', async () => {
    vi.mocked(stat).mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' })
    )
    await ensureDirectory('D:\\Downloads\\Archives')
    expect(mkdir).toHaveBeenCalledWith('D:\\Downloads\\Archives', {
      recursive: true,
    })
  })

  it.each(['EPERM', 'EACCES', 'EIO', 'ENOTDIR'])(
    'propagates %s when inspecting a directory',
    async (code) => {
      const error = Object.assign(new Error('stat failed'), { code })
      vi.mocked(stat).mockRejectedValue(error)
      await expect(ensureDirectory('D:\\')).rejects.toBe(error)
      expect(mkdir).not.toHaveBeenCalled()
    }
  )

  it.each(['EPERM', 'EACCES'])(
    'propagates %s when creating a missing directory',
    async (code) => {
      vi.mocked(stat).mockRejectedValue(
        Object.assign(new Error('missing'), { code: 'ENOENT' })
      )
      const error = Object.assign(new Error('mkdir failed'), { code })
      vi.mocked(mkdir).mockRejectedValue(error)
      await expect(ensureDirectory('D:\\Downloads')).rejects.toBe(error)
    }
  )

  it('preserves mkdir failure for an existing non-directory entry', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => false } as Stats)
    const error = Object.assign(new Error('file exists'), { code: 'EEXIST' })
    vi.mocked(mkdir).mockRejectedValue(error)
    await expect(ensureDirectory('D:\\file.zip')).rejects.toBe(error)
    expect(mkdir).toHaveBeenCalledWith('D:\\file.zip', { recursive: true })
  })
})
