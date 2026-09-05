import type { DownloadTask } from '@shared/types/task'
import { TaskStatus, TransitionPhase } from '@shared/types/task'

/**
 * Engine completion notifications are level-like and may repeat after BT
 * reseed or startup. Only a task that has not reached its final path and has
 * no durable transition intent may enter finalize from such a notification.
 * Startup recovery invokes finalize directly after inspecting the filesystem,
 * so quarantined/non-idle tasks remain recoverable without event re-entry.
 *
 * A final-path RPC task also passes this guard. Its terminal persistence and
 * engine retirement belong to CompletedEngineTaskCleanup, independently of
 * whether this notification needs to initiate a rename.
 */
export function shouldSkipEngineCompletionFinalize(
  task: DownloadTask
): boolean {
  return (
    task.diskPath === task.finalPath ||
    task.status === TaskStatus.Finalizing ||
    task.transitionPhase !== TransitionPhase.Idle
  )
}
