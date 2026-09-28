// @vitest-environment node

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRevealInFolderHandler } from './reveal-in-folder'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  stat: vi.fn(),
}))

const statMock = vi.mocked(stat)
const fileStat = { isDirectory: () => false } as Awaited<
  ReturnType<typeof stat>
>
const directoryStat = { isDirectory: () => true } as Awaited<
  ReturnType<typeof stat>
>
const missingPath = () =>
  Object.assign(new Error('missing'), { code: 'ENOENT' })

beforeEach(() => {
  statMock.mockReset().mockResolvedValue(fileStat)
})

describe('revealInFolder', () => {
  it('reveals the current path owned by the requested task', async () => {
    const shell = { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') }
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
    const shell = { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') }
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

  it.each(['direct', 'indexed-bt', 'queued'])(
    'opens the destination folder while the %s output is still missing',
    async (kind) => {
      const fs =
        await vi.importActual<typeof import('node:fs/promises')>(
          'node:fs/promises'
        )
      statMock.mockImplementation(fs.stat)
      const saveDir = await mkdtemp(path.join(tmpdir(), 'motrix-reveal-'))
      const finalPath = path.join(saveDir, 'download.iso')
      const diskPath =
        kind === 'indexed-bt'
          ? path.join(saveDir, '.motrix', 'workspace', 'p')
          : `${finalPath}.motrix`
      const shell = {
        showItemInFolder: vi.fn(),
        openPath: vi.fn(async () => ''),
      }
      const handler = createRevealInFolderHandler({
        shell,
        getTask: () => ({ diskPath, finalPath }),
      })

      try {
        if (kind === 'indexed-bt') await mkdir(diskPath, { recursive: true })
        else if (kind === 'direct') await writeFile(diskPath, 'partial')

        await handler({ taskId: 'downloading-task' })

        expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(saveDir)
        expect(shell.showItemInFolder).not.toHaveBeenCalled()

        await writeFile(finalPath, 'complete')
        shell.openPath.mockClear()
        await handler({ taskId: 'downloading-task' })

        expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(
          finalPath
        )
        expect(shell.openPath).not.toHaveBeenCalled()
      } finally {
        await rm(saveDir, { recursive: true, force: true })
      }
    }
  )

  it('opens a Windows containing folder when the final output is missing', async () => {
    statMock
      .mockRejectedValueOnce(missingPath())
      .mockResolvedValueOnce(directoryStat)
    const shell = { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') }
    const handler = createRevealInFolderHandler({
      shell,
      getTask: () => ({
        diskPath: 'C:\\Downloads\\file.iso.motrix',
        finalPath: 'C:\\Downloads\\file.iso',
      }),
    })

    await handler({ taskId: 'task-windows' })

    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith('C:\\Downloads')
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  it.each(['missing', 'file', 'denied'])(
    'rejects a %s containing folder without launching a file',
    async (kind) => {
      statMock.mockRejectedValueOnce(missingPath())
      if (kind === 'file') statMock.mockResolvedValueOnce(fileStat)
      else
        statMock.mockRejectedValueOnce(
          Object.assign(new Error('unavailable'), {
            code: kind === 'missing' ? 'ENOENT' : 'EACCES',
          })
        )
      const shell = {
        showItemInFolder: vi.fn(),
        openPath: vi.fn(async () => ''),
      }
      const handler = createRevealInFolderHandler({
        shell,
        getTask: () => ({ diskPath: '', finalPath: '/downloads/file.iso' }),
      })

      await expect(handler({ taskId: 'task-1' })).rejects.toThrow()
      expect(shell.openPath).not.toHaveBeenCalled()
      expect(shell.showItemInFolder).not.toHaveBeenCalled()
    }
  )

  it('propagates file manager failures instead of reporting success', async () => {
    statMock
      .mockRejectedValueOnce(missingPath())
      .mockResolvedValueOnce(directoryStat)
    const shell = {
      showItemInFolder: vi.fn(),
      openPath: vi.fn(async () => 'OS failed to open /downloads'),
    }
    const handler = createRevealInFolderHandler({
      shell,
      getTask: () => ({ diskPath: '', finalPath: '/downloads/file.iso' }),
    })

    await expect(handler({ taskId: 'task-1' })).rejects.toThrow(
      /cannot be revealed/
    )
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  it('does not treat a permission error as a missing output', async () => {
    statMock.mockRejectedValueOnce(
      Object.assign(new Error('denied'), { code: 'EACCES' })
    )
    const shell = { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') }
    const handler = createRevealInFolderHandler({
      shell,
      getTask: () => ({ diskPath: '', finalPath: '/downloads/file.iso' }),
    })

    await expect(handler({ taskId: 'task-1' })).rejects.toThrow()
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it('rejects an unknown task instead of accepting a renderer path', async () => {
    const shell = { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') }
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
    const shell = { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') }
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
    const shell = { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') }
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
    const shell = { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') }
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
