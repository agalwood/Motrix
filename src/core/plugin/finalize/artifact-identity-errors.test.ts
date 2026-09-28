import { lstat, open } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { readArtifactIdentity } from './artifact-identity'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const lstat = vi.fn(actual.lstat)
  const open = vi.fn(actual.open)
  return { ...actual, default: { ...actual, lstat, open }, lstat, open }
})

describe('artifact identity I/O errors', () => {
  it.each(['EACCES', 'EIO', 'ETIMEDOUT', 'ELOOP'])(
    'does not treat lstat %s as a missing file',
    async (code) => {
      const error = Object.assign(new Error(code), { code })
      vi.mocked(lstat).mockRejectedValueOnce(error)
      await expect(readArtifactIdentity('/unavailable/file')).rejects.toBe(
        error
      )
    }
  )

  it.each(['EACCES', 'EIO', 'ETIMEDOUT', 'ELOOP'])(
    'does not treat open %s as a missing file',
    async (code) => {
      const error = Object.assign(new Error(code), { code })
      vi.mocked(lstat).mockResolvedValueOnce({
        isSymbolicLink: () => false,
        isFile: () => true,
      } as Awaited<ReturnType<typeof lstat>>)
      vi.mocked(open).mockRejectedValueOnce(error)
      await expect(readArtifactIdentity('/unavailable/file')).rejects.toBe(
        error
      )
    }
  )

  it('still classifies ENOENT as a missing artifact', async () => {
    vi.mocked(lstat).mockRejectedValueOnce(
      Object.assign(new Error('missing'), { code: 'ENOENT' })
    )
    await expect(readArtifactIdentity('/missing/file')).rejects.toMatchObject({
      code: 'artifact_missing',
    })
  })
})
