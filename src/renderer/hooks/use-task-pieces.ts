import {
  createLruCache,
  usePolledQuery,
} from '@renderer/hooks/use-polled-query'
import { Queries } from '@shared/protocol/queries'
import type { TaskPiecesResult } from '@shared/types/pieces'

const CACHE_LIMIT = 32
const piecesCache = createLruCache<TaskPiecesResult>(CACHE_LIMIT)

function piecesEqual(a: TaskPiecesResult, b: TaskPiecesResult): boolean {
  return (
    a.bitfield === b.bitfield &&
    a.numPieces === b.numPieces &&
    a.pieceLength === b.pieceLength
  )
}

export function __clearPiecesCacheForTests(): void {
  piecesCache.clear()
}

export function useTaskPieces(
  taskId: string | null,
  enabled = true,
  engineTaskId?: string
) {
  const pieces = usePolledQuery<TaskPiecesResult>(
    Queries.GetTaskPieces,
    taskId === null
      ? null
      : engineTaskId === undefined
        ? taskId
        : `${taskId}:${engineTaskId}`,
    taskId !== null ? { taskId } : null,
    { cache: piecesCache, equals: piecesEqual, enabled, intervalMs: 1_000 }
  )
  return { pieces }
}
