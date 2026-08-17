import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it, vi } from 'vitest'
import { createGetTaskPiecesHandler } from './get-task-pieces'

function task(over: Partial<DownloadTask> = {}): DownloadTask {
  return makeDownloadTask(over)
}

describe('getTaskPieces handler', () => {
  it('returns engine-reported pieces for a live HTTP task', async () => {
    const engineAdapter = {
      getTaskPieces: vi.fn().mockResolvedValue({
        pieceLength: 1_048_576,
        numPieces: 8,
        bitfield: 'c0',
      }),
    }
    const taskManager = {
      getById: vi.fn().mockReturnValue(task({ engineTaskId: 'gid-http' })),
    }
    const handler = createGetTaskPiecesHandler({ engineAdapter, taskManager })

    await expect(handler({ taskId: 'task-http' })).resolves.toEqual({
      pieceLength: 1_048_576,
      numPieces: 8,
      bitfield: 'c0',
    })
    expect(engineAdapter.getTaskPieces).toHaveBeenCalledWith('gid-http')
  })

  it('synthesizes a complete map for a completed task whose engine row is gone', async () => {
    const engineAdapter = { getTaskPieces: vi.fn().mockResolvedValue(null) }
    const taskManager = {
      getById: vi.fn().mockReturnValue(
        task({
          engineTaskId: 'gid-complete',
          status: TaskStatus.Completed,
          totalBytes: 100,
          pieceLength: 30,
        })
      ),
    }
    const handler = createGetTaskPiecesHandler({ engineAdapter, taskManager })

    await expect(handler({ taskId: 'task-complete' })).resolves.toEqual({
      pieceLength: 30,
      numPieces: 4,
      bitfield: 'f',
    })
  })

  it('synthesizes when a completed engine row has no piece fields', async () => {
    const engineAdapter = {
      getTaskPieces: vi.fn().mockResolvedValue({
        pieceLength: 0,
        numPieces: 0,
        bitfield: '',
      }),
    }
    const taskManager = {
      getById: vi.fn().mockReturnValue(
        task({
          status: TaskStatus.Completed,
          totalBytes: 5 * 16_384,
          pieceLength: 16_384,
        })
      ),
    }
    const handler = createGetTaskPiecesHandler({ engineAdapter, taskManager })

    await expect(handler({ taskId: 'task-complete' })).resolves.toEqual({
      pieceLength: 16_384,
      numPieces: 5,
      bitfield: 'ff',
    })
  })

  it.each([TaskStatus.Error, TaskStatus.Removed])(
    'does not synthesize an all-complete map for %s tasks',
    async (status) => {
      const engineAdapter = { getTaskPieces: vi.fn().mockResolvedValue(null) }
      const taskManager = {
        getById: vi
          .fn()
          .mockReturnValue(task({ status, totalBytes: 100, pieceLength: 30 })),
      }
      const handler = createGetTaskPiecesHandler({ engineAdapter, taskManager })

      await expect(handler({ taskId: 'task-terminal' })).resolves.toEqual({
        pieceLength: 0,
        numPieces: 0,
        bitfield: '',
      })
    }
  )

  it('returns zero-shape without calling the engine for an engine-less task', async () => {
    const engineAdapter = { getTaskPieces: vi.fn() }
    const taskManager = {
      getById: vi.fn().mockReturnValue(task({ engineTaskId: '' })),
    }
    const handler = createGetTaskPiecesHandler({ engineAdapter, taskManager })

    await expect(handler({ taskId: 'media-task' })).resolves.toEqual({
      pieceLength: 0,
      numPieces: 0,
      bitfield: '',
    })
    expect(engineAdapter.getTaskPieces).not.toHaveBeenCalled()
  })

  it('returns zero-shape when the task does not exist', async () => {
    const engineAdapter = { getTaskPieces: vi.fn() }
    const taskManager = { getById: vi.fn().mockReturnValue(undefined) }
    const handler = createGetTaskPiecesHandler({ engineAdapter, taskManager })

    await expect(handler({ taskId: 'missing' })).resolves.toEqual({
      pieceLength: 0,
      numPieces: 0,
      bitfield: '',
    })
    expect(engineAdapter.getTaskPieces).not.toHaveBeenCalled()
  })
})
