import { describe, expect, it, vi } from 'vitest'
import { createRevealInFolderHandler } from './reveal-in-folder'

describe('revealInFolder', () => {
  it('reveals the current path owned by the requested task', async () => {
    const shell = { showItemInFolder: vi.fn() }
    const handler = createRevealInFolderHandler({
      shell,
      getTask: (taskId) =>
        taskId === 'task-1'
          ? {
              diskPath: '/Users/me/Downloads/file.iso',
              finalPath: '/Users/me/Downloads/file.iso',
            }
          : undefined,
    })

    await handler({ taskId: 'task-1' })

    expect(shell.showItemInFolder).toHaveBeenCalledWith(
      '/Users/me/Downloads/file.iso'
    )
  })

  it('hides an indexed BT workspace behind its stable final path', async () => {
    const shell = { showItemInFolder: vi.fn() }
    const handler = createRevealInFolderHandler({
      shell,
      getTask: () => ({
        diskPath: '/Users/me/Downloads/.motrix/61282448e78c1fc29ac1/p',
        finalPath: '/Users/me/Downloads/sample-data',
      }),
    })

    await handler({ taskId: 'task-bt' })

    expect(shell.showItemInFolder).toHaveBeenCalledWith(
      '/Users/me/Downloads/sample-data'
    )
  })

  it('rejects an unknown task instead of accepting a renderer path', async () => {
    const shell = { showItemInFolder: vi.fn() }
    const handler = createRevealInFolderHandler({
      shell,
      getTask: () => undefined,
    })

    await expect(handler({ taskId: 'missing' })).rejects.toThrow(/not found/i)
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  it.each([
    '\\\\server\\share\\downloads\\file.iso',
    '//server/share/downloads/file.iso',
  ])('allows a task-owned UNC path: %s', async (diskPath) => {
    const shell = { showItemInFolder: vi.fn() }
    const handler = createRevealInFolderHandler({
      shell,
      getTask: () => ({ diskPath, finalPath: '' }),
    })

    await handler({ taskId: 'task-unc' })

    expect(shell.showItemInFolder).toHaveBeenCalledWith(diskPath)
  })

  it.each([
    '\\\\?\\C:\\downloads\\file.iso',
    '\\\\.\\PhysicalDrive0',
    '\\??\\C:\\downloads\\file.iso',
    '//?/C:/downloads/file.iso',
  ])('rejects a Windows device namespace: %s', async (diskPath) => {
    const shell = { showItemInFolder: vi.fn() }
    const handler = createRevealInFolderHandler({
      shell,
      getTask: () => ({ diskPath, finalPath: '' }),
    })

    await expect(handler({ taskId: 'task-device' })).rejects.toThrow(
      /invalid path/i
    )
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  it('rejects a relative task path', async () => {
    const shell = { showItemInFolder: vi.fn() }
    const handler = createRevealInFolderHandler({
      shell,
      getTask: () => ({
        diskPath: '../downloads/file.iso',
        finalPath: '',
      }),
    })

    await expect(handler({ taskId: 'task-relative' })).rejects.toThrow(
      /invalid path/i
    )
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })
})
