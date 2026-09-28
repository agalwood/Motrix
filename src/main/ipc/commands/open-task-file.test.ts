// @vitest-environment node
import { stat } from 'node:fs/promises'
import { ErrorCode } from '@shared/errors'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createOpenTaskFileHandler } from './open-task-file'

vi.mock('node:fs/promises', () => ({ stat: vi.fn() }))

function setup() {
  const task = makeDownloadTask({
    id: 'a',
    status: TaskStatus.Completed,
    fileCount: 1,
    finalPath: '/downloads/final.bin',
    diskPath: '/downloads/partial.bin',
  })
  const shell = { openPath: vi.fn(async () => '') }
  const getTask = vi.fn(() => task)
  return {
    task,
    shell,
    getTask,
    handler: createOpenTaskFileHandler({ shell, getTask }),
  }
}

beforeEach(() => {
  vi.mocked(stat)
    .mockReset()
    .mockResolvedValue({ isFile: () => true } as Awaited<
      ReturnType<typeof stat>
    >)
})

describe('openTaskFile', () => {
  it('opens only the published file owned by the task, ignoring supplied paths', async () => {
    const { handler, shell } = setup()
    await handler({ taskId: 'a', path: '/some/other/file' })
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(
      '/downloads/final.bin'
    )
  })

  it.each([
    TaskStatus.Downloading,
    TaskStatus.Finalizing,
    TaskStatus.Seeding,
    TaskStatus.Removed,
    TaskStatus.Error,
  ])('rejects %s tasks at execution time', async (status) => {
    const { handler, task, shell } = setup()
    task.status = status
    await expect(handler({ taskId: 'a' })).rejects.toMatchObject({
      code: ErrorCode.InvalidSelection,
    })
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it('rejects multi-file tasks even when they claim a file path', async () => {
    const { handler, task, shell } = setup()
    task.fileCount = 2
    await expect(handler({ taskId: 'a' })).rejects.toMatchObject({
      code: ErrorCode.InvalidSelection,
    })
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it.each([
    'relative/file',
    'https://example.test/file',
    '//?/C:/file',
    '/downloads/\0file',
  ])('rejects an invalid stored path: %s', async (output) => {
    const { handler, task, shell } = setup()
    task.finalPath = output
    await expect(handler({ taskId: 'a' })).rejects.toMatchObject({
      code: ErrorCode.IpcInvalidPayload,
    })
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it.each(['missing', 'directory', 'denied'])(
    'does not open a %s output',
    async (kind) => {
      const { handler, shell } = setup()
      if (kind === 'directory')
        vi.mocked(stat).mockResolvedValueOnce({
          isFile: () => false,
        } as Awaited<ReturnType<typeof stat>>)
      else vi.mocked(stat).mockRejectedValueOnce(new Error(kind))
      await expect(handler({ taskId: 'a' })).rejects.toMatchObject({
        code: ErrorCode.TaskOpenFailed,
      })
      expect(shell.openPath).not.toHaveBeenCalled()
    }
  )

  it('rechecks the task after the filesystem read', async () => {
    const { handler, task, shell } = setup()
    vi.mocked(stat).mockImplementationOnce(async () => {
      task.status = TaskStatus.Removed
      return { isFile: () => true } as Awaited<ReturnType<typeof stat>>
    })
    await expect(handler({ taskId: 'a' })).rejects.toMatchObject({
      code: ErrorCode.TaskOpenFailed,
    })
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it('reports an operating system open failure', async () => {
    const { handler, shell } = setup()
    shell.openPath.mockResolvedValueOnce('No application available')
    await expect(handler({ taskId: 'a' })).rejects.toMatchObject({
      code: ErrorCode.TaskOpenFailed,
    })
  })

  it.each([null, {}, { taskId: '' }, { taskId: 3 }])(
    'rejects invalid requests',
    async (payload) => {
      const { handler, shell } = setup()
      await expect(handler(payload)).rejects.toMatchObject({
        code: ErrorCode.IpcInvalidPayload,
      })
      expect(shell.openPath).not.toHaveBeenCalled()
    }
  )
})
