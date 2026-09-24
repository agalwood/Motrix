import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskType } from '@shared/types/task'
import { shell } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileCleanupServiceImpl } from '../../core/task/file-cleanup-service'
import { removeTaskPath } from './task-file-remover'

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }))

describe('desktop task file deletion', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'motrix-task-delete-'))
    vi.mocked(shell.trashItem).mockReset()
    await fs.mkdir(path.join(root, 'trash'))
    vi.mocked(shell.trashItem).mockImplementation(async (target) => {
      await fs.rename(target, path.join(root, 'trash', path.basename(target)))
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('trashes a partial HTTP download and its control file', async () => {
    const target = path.join(root, 'file.motrix')
    await fs.writeFile(target, 'download')
    await fs.writeFile(`${target}.aria2`, 'control')
    const cleanup = new FileCleanupServiceImpl({
      removePathRecursive: (file) => removeTaskPath(file, 'trash'),
    })

    await cleanup.cleanup(target, TaskType.Http)

    expect(vi.mocked(shell.trashItem).mock.calls).toEqual([
      [target],
      [`${target}.aria2`],
    ])
    expect(
      await fs.readFile(path.join(root, 'trash/file.motrix'), 'utf8')
    ).toBe('download')
    expect(
      await fs.readFile(path.join(root, 'trash/file.motrix.aria2'), 'utf8')
    ).toBe('control')
  })

  it('trashes a BT directory with its contents', async () => {
    const target = path.join(root, 'torrent')
    await fs.mkdir(target)
    await fs.writeFile(path.join(target, 'file'), 'download')
    await removeTaskPath(target, 'trash')
    expect(
      await fs.readFile(path.join(root, 'trash/torrent/file'), 'utf8')
    ).toBe('download')
  })

  it('keeps files when the OS cannot move them to trash', async () => {
    const target = path.join(root, 'file')
    await fs.writeFile(target, 'download')
    const error = new Error('Trash unavailable')
    vi.mocked(shell.trashItem).mockRejectedValue(error)

    await expect(removeTaskPath(target, 'trash')).rejects.toBe(error)
    expect(await fs.readFile(target, 'utf8')).toBe('download')
  })

  it('ignores absent files and does not hide filesystem access errors', async () => {
    const target = path.join(root, 'missing')
    await expect(removeTaskPath(target, 'trash')).resolves.toBeUndefined()
    expect(shell.trashItem).not.toHaveBeenCalled()

    const error = Object.assign(new Error('Permission denied'), {
      code: 'EACCES',
    })
    vi.spyOn(fs, 'lstat').mockRejectedValue(error)
    await expect(removeTaskPath(target, 'trash')).rejects.toBe(error)
    expect(shell.trashItem).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'trashes broken symlinks',
    async () => {
      const target = path.join(root, 'link')
      await fs.symlink(path.join(root, 'missing'), target)
      await removeTaskPath(target, 'trash')
      expect(shell.trashItem).toHaveBeenCalledWith(target)
      expect(
        (await fs.lstat(path.join(root, 'trash/link'))).isSymbolicLink()
      ).toBe(true)
    }
  )

  it('deletes directly only when permanent deletion is selected', async () => {
    const target = path.join(root, 'torrent')
    await fs.mkdir(target)
    await fs.writeFile(path.join(target, 'file'), 'download')
    await removeTaskPath(target, 'permanent')
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(removeTaskPath(target, 'permanent')).resolves.toBeUndefined()
    expect(shell.trashItem).not.toHaveBeenCalled()
  })
})
