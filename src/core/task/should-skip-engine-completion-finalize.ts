import type { DownloadTask } from '@shared/types/task'
import { TaskStatus, TransitionPhase } from '@shared/types/task'

/**
 * Engine completion notifications are level-like and may repeat after BT
 * reseed or startup. Only a task that has not reached its final path and has
 * no durable transition intent may enter finalize from such a notification.
 * Startup recovery invokes finalize directly after inspecting the filesystem,
 * so quarantined/non-idle tasks remain recoverable without event re-entry.
 *
 * The poll-vs-notify race where a poll tick commits a task straight to
 * Completed/Error before this notification-driven path observes the same
 * engine-completion event is unreachable today (polling has no tellStopped
 * path). `diskPath === finalPath` already covers an already-terminal,
 * already-renamed task, so no separate terminal-status clause is needed.
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
