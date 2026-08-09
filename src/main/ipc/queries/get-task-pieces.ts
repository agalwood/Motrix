import type { EngineAdapter } from '@core/engine/engine-adapter'
import type { TaskPiecesResult } from '@shared/types/pieces'
import type { DownloadTask } from '@shared/types/task'

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
 * For BT tasks evicted from aria2 post-seeding, the engine returns null.
 * Synthesize a "fully complete" piece map from the persisted pieceLength
 * (motrix.db) and totalBytes — bitfield filled with 'f' so every piece
 * cell renders as done. Returns EMPTY when pieceLength is 0 (non-BT,
 * legacy row pre-v4 migration, or polling never captured it).
 */
function synthesizeCompletePieces(task: DownloadTask): TaskPiecesResult {
  const pieceLength = task.bt?.pieceLength ?? 0
  if (pieceLength <= 0 || task.totalBytes <= 0) return EMPTY
  const numPieces = Math.ceil(task.totalBytes / pieceLength)
  // 4 pieces per hex char (nibble). Trailing bits past `numPieces` are
  // ignored by statesFromBitfield, so over-filling with 'f' is safe.
  const bitfield = 'f'.repeat(Math.ceil(numPieces / 4))
  return { pieceLength, numPieces, bitfield }
}

export function createGetTaskPiecesHandler(deps: GetTaskPiecesDeps) {
  return async ({
    taskId,
  }: GetTaskPiecesPayload): Promise<TaskPiecesResult> => {
    const task = deps.taskManager.getById(taskId)
    if (!task) return EMPTY
    const result = await deps.engineAdapter.getTaskPieces(task.engineTaskId)
    if (result) return result
    return synthesizeCompletePieces(task)
  }
}
