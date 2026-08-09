import { AppError, ErrorCode } from '@shared/errors'
import { parseTaskInspectorActivitySnapshot } from '@shared/schemas/task-inspector-activity'
import type { TaskInspectorActivitySnapshot } from '@shared/types/task-inspector-activity'
import { assertTaskId } from './validators'

export interface TaskInspectorActivitySnapshotReader {
  snapshot(taskId: string): unknown
}

export interface TaskInspectorActivityQueryOptions {
  /**
   * Test-only fault injection. The first valid query delegates normally and
   * every later query fails without touching the runtime.
   */
  failAfterFirstQuery?: boolean
}

export interface TaskInspectorActivityQuery {
  snapshot(params: unknown): TaskInspectorActivitySnapshot
}

export function createTaskInspectorActivityQuery(
  reader: TaskInspectorActivitySnapshotReader,
  options: TaskInspectorActivityQueryOptions = {}
): TaskInspectorActivityQuery {
  let queryCount = 0
  return {
    snapshot(params: unknown): TaskInspectorActivitySnapshot {
      const invalid = (): never => {
        throw new AppError(
          ErrorCode.IpcInvalidPayload,
          'Invalid Task Inspector Activity query params'
        )
      }
      if (
        typeof params !== 'object' ||
        params === null ||
        (Object.getPrototypeOf(params) !== Object.prototype &&
          Object.getPrototypeOf(params) !== null)
      ) {
        return invalid()
      }
      const keys = Reflect.ownKeys(params)
      if (keys.length !== 1 || keys[0] !== 'taskId') {
        return invalid()
      }
      const descriptor = Object.getOwnPropertyDescriptor(params, 'taskId')
      if (!descriptor || !('value' in descriptor)) {
        return invalid()
      }
      let taskId: string
      try {
        taskId = assertTaskId(descriptor.value as string)
      } catch {
        return invalid()
      }
      queryCount += 1
      if (options.failAfterFirstQuery && queryCount > 1) {
        throw new Error('deterministic Task Inspector Activity query failure')
      }
      const result = reader.snapshot(taskId)
      if (result == null) {
        throw new AppError(ErrorCode.TaskNotFound, `Task not found: ${taskId}`)
      }
      const snapshot = parseTaskInspectorActivitySnapshot(result, taskId)
      if (!snapshot) {
        throw new Error('Invalid Task Inspector Activity snapshot')
      }
      return snapshot
    },
  }
}
