import type { DownloadTask } from '@shared/types/task'
import { isTerminalTaskStatus } from '@shared/types/task-actions'

/**
 * Clear engine-sampled metrics once a task can no longer transfer data.
 *
 * These values are process-local snapshots rather than durable task history.
 * Keeping the final polling sample on Completed/Error makes a terminal task
 * look active (for example, a Completed HTTP task can retain ETA 00:02).
 * Seeding is intentionally excluded because its upload speed and connections
 * remain live and must continue to be refreshed by engine polling.
 */
export function normalizeTerminalRuntimeMetrics(task: DownloadTask): void {
  if (!isTerminalTaskStatus(task.status)) {
    return
  }

  task.downloadSpeed = 0
  task.uploadSpeed = 0
  task.etaSeconds = 0
  task.connections = 0
}
