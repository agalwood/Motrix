import { TaskStatus } from '@shared/types/task'
import {
  commitTaskUpdate,
  getTaskOrWarn,
  reconcileTask,
  type TaskActionDeps,
} from './shared'

/**
 * Pause a task by its domain taskId.
 * Domain → engine translation happens exactly once, on the adapter call.
 *
 * After the engine accepts the pause, an optimistic local-state update
 * sets status to Paused and emits TaskUpdated so the renderer reflects
 * the change immediately rather than waiting up to 10 seconds for the
 * idle-mode polling cycle. The next poll authoritatively overwrites
 * this entry with the engine's view.
 */
export async function pauseTask(
  taskId: string,
  deps: TaskActionDeps
): Promise<void> {
  const task = getTaskOrWarn(deps, taskId, 'pauseTask')
  if (!task) return
  const optimistic = {
    ...task,
    status: TaskStatus.Paused,
    downloadSpeed: 0,
    uploadSpeed: 0,
    etaSeconds: 0,
    updatedAt: Date.now(),
  }

  // Coordinator-managed media task (kind Mux/Hls) has engineTaskId '' — it has
  // no single aria2 handle, so pause the real, in-flight segment gids instead.
  // Calling the engine with '' is exactly the "Invalid GID" crash we're fixing.
  if (!task.engineTaskId) {
    const gids = deps.getMediaSegmentGids?.(taskId) ?? []
    if (gids.length === 0) {
      // No segments in flight (ffmpeg mux phase, or the brief window before the
      // first addUri resolves). canPause() already disables the button during
      // mux; a stray click here is a harmless no-op rather than a spurious
      // "Invalid GID" / error toast.
      deps.log.debug({ taskId }, 'pauseTask: media task has no active segments')
      return
    }
    // A paused segment fires no onComplete, so the coordinator's run() simply
    // waits; resume lets the segment finish and the pipeline continues.
    await Promise.all(gids.map((gid) => deps.adapter.pauseTask(gid)))
    await commitTaskUpdate(task, optimistic, deps)
    return
  }

  try {
    await deps.adapter.pauseTask(task.engineTaskId)
  } catch (err) {
    await reconcileTask(task, deps, { emitFallback: false })
    throw err
  }
  await reconcileTask(optimistic, deps, {
    accuracy: 'exact',
    transitionFromStatus: task.status,
  })
}
