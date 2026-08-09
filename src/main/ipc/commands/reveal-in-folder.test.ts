import { describe, expect, it, vi } from 'vitest'
import { createRevealInFolderHandler } from './reveal-in-folder'

describe('revealInFolder', () => {
  it('calls electron shell.showItemInFolder with the provided path', async () => {
    const shell = { showItemInFolder: vi.fn() }
    const handler = createRevealInFolderHandler({ shell })
    await handler({ path: '/Users/me/Downloads/file.iso' })
    expect(shell.showItemInFolder).toHaveBeenCalledWith(
      '/Users/me/Downloads/file.iso'
    )
  })

  it('throws AppError when path is empty', async () => {
    const shell = { showItemInFolder: vi.fn() }
    const handler = createRevealInFolderHandler({ shell })
    await expect(handler({ path: '' })).rejects.toThrow(/invalid/i)
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })
})
