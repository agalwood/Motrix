import type { SessionManager } from '@core/session/session-manager'
import type { TaskManager } from '@core/task/task-manager'
import type { DownloadTask } from '@shared/types/task'
import type { TaskOccurrence } from '@shared/types/task-occurrence'

/**
 * Build the per-task persistence hook used by server-side task lifecycle
 * coordinators. The candidate is written directly through SessionManager's
 * ownership queue and remains unpublished until the caller crosses the
 * barrier. requestSave() is intentionally not used: lifecycle callers need a
 * rejecting durability barrier.
 */
export function createServerPersistTask(
  _taskManager: Pick<TaskManager, 'set'>,
  sessionManager: Pick<SessionManager, 'persistTask'>
): (task: DownloadTask) => Promise<void> {
  return (task) => sessionManager.persistTask(task)
}

/**
 * Same durable barrier as `createServerPersistTask`, but additionally appends
 * the task's terminal occurrence (when non-null) to the outbox in the SAME
 * SQLite transaction. Passed as `persistTaskWithOccurrence` to every commit
 * path that can reach Completed/Error, INSTEAD OF `persistTask`.
 */
export function createServerPersistTaskWithOccurrence(
  sessionManager: Pick<SessionManager, 'persistTaskWithOccurrence'>
): (task: DownloadTask, occurrence: TaskOccurrence | null) => Promise<void> {
  return (task, occurrence) =>
    sessionManager.persistTaskWithOccurrence(task, occurrence)
}
