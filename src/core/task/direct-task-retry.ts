import type { EngineAdapter } from '@core/engine/engine-adapter'
import type { TaskManager } from '@core/task/task-manager'
import { taskIdsPayloadSchema } from '@shared/schemas/bulk-task-command'
import { type DownloadTask, TaskInstancePhase } from '@shared/types/task'
import { canRetryWithParameters } from '@shared/types/task-actions'

export function directTaskRetryInput(task: DownloadTask) {
  if (!canRetryWithParameters(task) || !task.engineTaskId) return null
  const primary = task.instances.find(
    (instance) => instance.phase === TaskInstancePhase.HttpDownload
  )
  if (
    !primary ||
    primary.gid !== task.engineTaskId ||
    primary.uris.length !== 1 ||
    !primary.diskPath ||
    primary.diskPath !== task.diskPath
  )
    return null
  return {
    engineTaskId: task.engineTaskId,
    uri: primary.uris[0],
    outputPath: primary.diskPath,
  }
}

export function createGetTaskHttpRetryAvailabilityHandler(
  taskManager: TaskManager,
  adapter: EngineAdapter
) {
  return async (payload: unknown): Promise<string[]> => {
    const ids = [...new Set(taskIdsPayloadSchema.max(1000).parse(payload))]
    if (!adapter.canRetryDirectTask || !adapter.retryDirectTask) return []
    const available: string[] = []
    // Keep engine/database work bounded even for a large selection.
    for (const id of ids) {
      const task = taskManager.getById(id)
      const input = task && directTaskRetryInput(task)
      if (input && (await adapter.canRetryDirectTask(input))) available.push(id)
    }
    return available
  }
}
