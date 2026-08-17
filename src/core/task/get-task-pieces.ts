import type { EngineAdapter } from '@core/engine/engine-adapter'
import type { TaskPiecesResult } from '@shared/types/pieces'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'

export interface GetTaskPiecesDeps {
  engineAdapter: Pick<EngineAdapter, 'getTaskPieces'>
  taskManager: {
    getById: (id: string) => DownloadTask | undefined
  }
}

export interface GetTaskPiecesPayload {
  taskId: string
}

const EMPTY: TaskPiecesResult = {
  pieceLength: 0,
  numPieces: 0,
  bitfield: '',
}

/**
 * Reconstruct the final all-complete map after finalize retires the engine
 * result. The exact piece length was captured from aria2 and persisted on the
 * task; trailing bits are ignored by the renderer.
 */
function synthesizeCompletePieces(task: DownloadTask): TaskPiecesResult {
  if (task.pieceLength <= 0 || task.totalBytes <= 0) return EMPTY
  const numPieces = Math.ceil(task.totalBytes / task.pieceLength)
  const bitfield = 'f'.repeat(Math.ceil(numPieces / 4))
  return { pieceLength: task.pieceLength, numPieces, bitfield }
}

export function createGetTaskPiecesHandler(deps: GetTaskPiecesDeps) {
  return async ({
    taskId,
  }: GetTaskPiecesPayload): Promise<TaskPiecesResult> => {
    const task = deps.taskManager.getById(taskId)
    if (!task) return EMPTY

    if (task.engineTaskId) {
      const result = await deps.engineAdapter.getTaskPieces(task.engineTaskId)
      if (
        result &&
        (result.numPieces > 0 || task.status !== TaskStatus.Completed)
      ) {
        return result
      }
    }

    // A missing engine row does not prove completion: error rows are evicted
    // too, and synthesizing those as all-green would misrepresent the failure.
    if (task.status !== TaskStatus.Completed) return EMPTY
    return synthesizeCompletePieces(task)
  }
}
