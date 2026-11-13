import { isNotFoundError } from '@core/engine/aria2/error-utils'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import { hasLegacyImport } from '@core/legacy-import/legacy-task-policy'
import { type DownloadTask, TaskStatus, TaskType } from '@shared/types/task'

/** Ready notifications are hints. Replay durable receipts after subscribing,
 * including a completion that happened while startup hooks were recovering. */
export async function reconcileHttpOutputs(
  tasks: readonly DownloadTask[],
  adapter: Pick<EngineAdapter, 'getHttpOutput'>,
  finalize: (taskId: string) => Promise<void>,
  log: { warn(context: Record<string, unknown>, message: string): void }
): Promise<void> {
  if (!adapter.getHttpOutput) return
  for (const task of tasks) {
    if (
      hasLegacyImport(task) ||
      !task.engineTaskId ||
      (task.type !== TaskType.Http && task.type !== TaskType.Ftp) ||
      task.status === TaskStatus.Completed ||
      task.status === TaskStatus.Removed
    )
      continue
    try {
      const output = await adapter.getHttpOutput(task.engineTaskId)
      if (
        !output.paused &&
        (output.state === 'ready' || output.state === 'published')
      )
        await finalize(task.id)
    } catch (error) {
      if (!isNotFoundError(error))
        log.warn(
          { taskId: task.id, error },
          'http_output_reconciliation_deferred'
        )
    }
  }
}
