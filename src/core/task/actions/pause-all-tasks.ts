import type { BulkTaskCommandResult } from '@shared/types/task-actions'
import { canPause } from '@shared/types/task-actions'
import { pauseTask } from './pause-task'
import type { TaskActionDeps } from './shared'

export interface BulkTaskActionFailure {
  taskId: string
  error: unknown
}

export interface BulkTaskActionResult {
  succeeded: string[]
  failed: BulkTaskActionFailure[]
}

/**
 * Fan a per-task action out over the given ids and collect the settled
 * outcomes. Shared by pauseAllTasks / resumeAllTasks and the plural IPC
 * commands (Commands.PauseTasks, …) so the bulk result semantics live in
 * one place.
 */
export async function runBulkTaskAction(
  taskIds: readonly string[],
  deps: TaskActionDeps,
  action: (taskId: string, deps: TaskActionDeps) => Promise<void>
): Promise<BulkTaskActionResult> {
  const settled = await Promise.allSettled(
    taskIds.map((taskId) => action(taskId, deps))
  )
  const result: BulkTaskActionResult = { succeeded: [], failed: [] }
  settled.forEach((outcome, index) => {
    const taskId = taskIds[index]
    if (outcome.status === 'fulfilled') {
      result.succeeded.push(taskId)
    } else {
      result.failed.push({ taskId, error: outcome.reason })
    }
  })
  // The per-task commits coalesce into the trailing window; close the bulk
  // action with one forced flush so its outcome is visible immediately
  // instead of one window later. Skipped when nothing was attempted — there
  // is no pending snapshot to force.
  if (taskIds.length > 0) deps.publishTaskUpdateNow()
  return result
}

/**
 * Map a bulk result onto the IPC-safe wire shape: Error objects do not
 * survive the boundary, so per-task failures are stringified.
 */
export function toBulkTaskCommandResult(
  result: BulkTaskActionResult
): BulkTaskCommandResult {
  return {
    succeeded: result.succeeded,
    failed: result.failed.map(({ taskId, error }) => ({
      taskId,
      reason: error instanceof Error ? error.message : String(error),
    })),
  }
}

export async function pauseAllTasks(
  deps: TaskActionDeps
): Promise<BulkTaskActionResult> {
  return runBulkTaskAction(
    deps.taskManager
      .getAll()
      .filter(canPause)
      .map((task) => task.id),
    deps,
    pauseTask
  )
}
