import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { applyTerminalTransition } from '../apply-terminal-transition'
import {
  commitTaskUpdate,
  getTaskOrWarn,
  reconcileTask,
  type TaskActionDeps,
} from './shared'

export interface StopSeedingTaskDeps extends TaskActionDeps {
  /**
   * Durable persistence barrier for the Completed transition. The action
   * resolves and emits TaskUpdated only after this hook commits.
   */
  persist: (task: DownloadTask) => Promise<void>
}

/**
 * Stop seeding a BT task. Domain-equivalent of the natural
 * Seeding → Completed eviction triggered by aria2 reaching
 * seed-time/seed-ratio targets, but driven by the user.
 *
 * Calls aria2.forceRemove on the seeding gid then marks the
 * task Completed and persists. The stale engineTaskId is
 * preserved on the task record (matches the natural eviction
 * path); a future ReAddTask (Re-seed) will overwrite it.
 */
export async function stopSeedingTask(
  taskId: string,
  deps: StopSeedingTaskDeps
): Promise<void> {
  const task = getTaskOrWarn(deps, taskId, 'stopSeedingTask')
  if (!task) return
  if (task.status !== TaskStatus.Seeding) {
    deps.log.warn(
      { taskId, status: task.status },
      'stopSeedingTask: task is not Seeding'
    )
    return
  }
  const now = Date.now()
  const optimistic = {
    ...task,
    ...applyTerminalTransition(task, TaskStatus.Completed, {}, now),
    downloadSpeed: 0,
    uploadSpeed: 0,
    etaSeconds: 0,
    updatedAt: now,
    instances: (task.instances ?? []).map((instance) => ({
      ...instance,
      status: TaskStatus.Completed,
      updatedAt: now,
    })),
  }
  try {
    // forceRemoveTask is idempotent for an already-evicted gid (the adapter
    // absorbs "not found"), so any error here is a real failure.
    await deps.adapter.forceRemoveTask(task.engineTaskId)
  } catch (err) {
    await reconcileTask(task, deps, { emitFallback: false })
    throw err
  }
  // forceRemove success is the authoritative action result. Any immediate
  // engine snapshot can be stale Seeding or the short-lived aria2 Removed
  // lifecycle state; neither may overwrite the domain outcome Completed.
  //
  // cause: 'engine' — this is domain-equivalent to the natural
  // Seeding -> Completed eviction aria2 performs itself once seed-time/
  // seed-ratio is reached (see the doc comment above); the user just
  // triggered it early. It is not a cancellation of a download in progress
  // (no 'user-cancel') and does not go through the finalize/rename pipeline
  // (no 'finalize') — the file is already at finalPath.
  await commitTaskUpdate(task, optimistic, deps, {
    persist: deps.persist,
    terminalCause: 'engine',
  })
}
