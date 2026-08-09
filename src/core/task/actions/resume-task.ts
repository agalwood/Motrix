import { TaskStatus } from '@shared/types/task'
import {
  commitTaskUpdate,
  getTaskOrWarn,
  reconcileTask,
  type TaskActionDeps,
} from './shared'

/**
 * Resume a paused task by its domain taskId.
 *
 * After the engine accepts the unpause, an optimistic local-state
 * update sets status to Downloading and emits TaskUpdated so the
 * renderer reflects the change immediately. Without this, the UI
 * waits for the next poll (up to 10 s in idle mode), and the user —
 * seeing no feedback — typically clicks Resume again, which the
 * engine then rejects with "GID#... cannot be unpaused now" because
 * the task is already active. The next poll authoritatively
 * overwrites this entry (e.g., to Queued if max-concurrent is full).
 */
export async function resumeTask(
  taskId: string,
  deps: TaskActionDeps
): Promise<void> {
  const task = getTaskOrWarn(deps, taskId, 'resumeTask')
  if (!task) return
  const optimistic = {
    ...task,
    status: TaskStatus.Downloading,
    updatedAt: Date.now(),
  }

  // Coordinator-managed media task (engineTaskId '') — resume the real segment
  // gids. Unpausing them lets each segment complete and the coordinator's
  // awaiting pipeline continues. Never call the engine with '' (Invalid GID).
  if (!task.engineTaskId) {
    const gids = deps.getMediaSegmentGids?.(taskId) ?? []
    if (gids.length === 0) {
      // Nothing in flight to resume (mux phase / transient window). No-op
      // rather than a spurious error — see the same guard in pauseTask.
      deps.log.debug(
        { taskId },
        'resumeTask: media task has no active segments'
      )
      return
    }
    await Promise.all(gids.map((gid) => deps.adapter.resumeTask(gid)))
    await commitTaskUpdate(task, optimistic, deps)
    return
  }

  try {
    await deps.adapter.resumeTask(task.engineTaskId)
  } catch (err) {
    const reconciled = await reconcileTask(task, deps, {
      emitFallback: false,
      ignoreErrorStatus: true,
    })
    if (
      reconciled &&
      reconciled.status !== TaskStatus.Paused &&
      reconciled.status !== TaskStatus.Error
    ) {
      return
    }
    throw err
  }
  await reconcileTask(optimistic, deps, {
    ignoreErrorStatus: true,
    accuracy: 'exact',
    transitionFromStatus: task.status,
  })
}
