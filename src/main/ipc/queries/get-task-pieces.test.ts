import type { DownloadTask } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it, vi } from 'vitest'
import { createGetTaskPiecesHandler } from './get-task-pieces'

// Minimal task fixture — handler reads engineTaskId, totalBytes, bt.pieceLength.
function task(over: Partial<DownloadTask> = {}): DownloadTask {
  return makeDownloadTask(over)
}

describe('getTaskPieces handler', () => {
  it('returns engine-reported pieces when task is found', async () => {
    const engineAdapter = {
      getTaskPieces: vi.fn().mockResolvedValue({
        pieceLength: 16384,
        numPieces: 8,
        bitfield: 'ff',
      }),
    }
    const taskManager = {
      getById: vi.fn().mockReturnValue(task({ engineTaskId: 'gid-1' })),
    }
    const handler = createGetTaskPiecesHandler({ engineAdapter, taskManager })
    const result = await handler({ taskId: 'task-1' })
    expect(result).toEqual({
      pieceLength: 16384,
      numPieces: 8,
      bitfield: 'ff',
    })
    expect(engineAdapter.getTaskPieces).toHaveBeenCalledWith('gid-1')
  })

  it('synthesizes full-complete piece map when engine returns null and pieceLength is known', async () => {
    const engineAdapter = {
      getTaskPieces: vi.fn().mockResolvedValue(null),
    }
    // 100 bytes / 30-byte pieces → ceil = 4 pieces; 4/4 = 1 hex char of 'f'
    const taskManager = {
      getById: vi.fn().mockReturnValue(
        task({
          engineTaskId: 'gid-2',
          totalBytes: 100,
          bt: { pieceLength: 30 } as DownloadTask['bt'],
        })
      ),
    }
    const handler = createGetTaskPiecesHandler({ engineAdapter, taskManager })
    expect(await handler({ taskId: 'task-2' })).toEqual({
      pieceLength: 30,
      numPieces: 4,
      bitfield: 'f',
    })
  })

  it('synthesizes for typical 4-piece torrent (over-fills bitfield safely)', async () => {
    const engineAdapter = {
      getTaskPieces: vi.fn().mockResolvedValue(null),
    }
    // 5 pieces → ceil(5/4) = 2 hex chars 'ff'; statesFromBitfield only
    // reads first 5 bits, the 3 trailing 1-bits are ignored.
    const taskManager = {
      getById: vi.fn().mockReturnValue(
        task({
          engineTaskId: 'gid-3',
          totalBytes: 5 * 16384,
          bt: { pieceLength: 16384 } as DownloadTask['bt'],
        })
      ),
    }
    const handler = createGetTaskPiecesHandler({ engineAdapter, taskManager })
    expect(await handler({ taskId: 'task-3' })).toEqual({
      pieceLength: 16384,
      numPieces: 5,
      bitfield: 'ff',
    })
  })

  it('returns zero-shape when engine null and pieceLength is unknown (legacy / non-BT)', async () => {
    const engineAdapter = {
      getTaskPieces: vi.fn().mockResolvedValue(null),
    }
    const taskManager = {
      getById: vi.fn().mockReturnValue(
        task({
          engineTaskId: 'gid-x',
          totalBytes: 1024,
          // bt undefined — non-BT, or BT with pre-v4 metadata
        })
      ),
    }
    const handler = createGetTaskPiecesHandler({ engineAdapter, taskManager })
    expect(await handler({ taskId: 'task-x' })).toEqual({
      pieceLength: 0,
      numPieces: 0,
      bitfield: '',
    })
  })

  it('returns zero-shape without calling engine when taskManager has no record', async () => {
    const engineAdapter = { getTaskPieces: vi.fn() }
    const taskManager = { getById: vi.fn().mockReturnValue(undefined) }
    const handler = createGetTaskPiecesHandler({ engineAdapter, taskManager })
    expect(await handler({ taskId: 'missing' })).toEqual({
      pieceLength: 0,
      numPieces: 0,
      bitfield: '',
    })
    expect(engineAdapter.getTaskPieces).not.toHaveBeenCalled()
  })
})
