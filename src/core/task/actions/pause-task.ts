import { assertLegacyTaskNotActivated } from '@core/legacy-import/legacy-task-policy'
import { TaskStatus } from '@shared/types/task'
import type { EngineAdapter } from '../../engine/engine-adapter'
import {
  commitTaskUpdate,
  getTaskOrWarn,
  reconcileTask,
  type TaskActionDeps,
} from './shared'

const pendingPauses = new WeakMap<EngineAdapter, Map<string, Promise<void>>>()
const recordedPauses = new WeakSet<Promise<void>>()

/** Share the engine request, allowing each caller to commit under its own lease. */
function pauseEngineTask(gid: string, adapter: EngineAdapter): Promise<void> {
  let pending = pendingPauses.get(adapter)
  if (!pending) {
    pending = new Map()
    pendingPauses.set(adapter, pending)
  }
  const existing = pending.get(gid)
  if (existing) return existing
  const operation = Promise.resolve()
    .then(() => adapter.pauseTask(gid))
    .finally(() => pending.delete(gid))
  pending.set(gid, operation)
  return operation
}

/** Concurrent callers publish independently but record one exact pause transition. */
function withPauseTransition(
  requests: readonly Promise<void>[],
  deps: TaskActionDeps
): TaskActionDeps {
  const recordTransition = deps.recordTransition
  if (!recordTransition) return deps
  return {
    ...deps,
    recordTransition: (input) => {
      if (input.nextStatus !== TaskStatus.Paused) return recordTransition(input)
      if (requests.some((request) => recordedPauses.has(request))) return
      for (const request of requests) recordedPauses.add(request)
      return recordTransition(input)
    },
  }
}

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
  assertLegacyTaskNotActivated(task)
  deps.onPauseRequested?.(taskId)
  if (task.status === TaskStatus.Paused) return
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
    const requests = gids.map((gid) => pauseEngineTask(gid, deps.adapter))
    await Promise.all(requests)
    await commitTaskUpdate(
      task,
      optimistic,
      withPauseTransition(requests, deps)
    )
    return
  }

  const request = pauseEngineTask(task.engineTaskId, deps.adapter)
  try {
    await request
  } catch (err) {
    await reconcileTask(task, deps, { emitFallback: false })
    throw err
  }
  await reconcileTask(optimistic, withPauseTransition([request], deps), {
    accuracy: 'exact',
    transitionFromStatus: task.status,
  })
}
