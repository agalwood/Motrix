import type { DownloadTask } from '@shared/types/task'

/**
 * Projection applied at the TaskUpdated broadcast and ListTasks boundaries
 * (option E of the emit-coalescing design): `bt.trackers`,
 * `bt.announceList`, and `bt.magnetUri` are static per-task tracker data
 * that never changes between polls yet accounts for ~51% of a realistic
 * full-list payload's bytes. Dropping them from the hot path halves every
 * structured clone / JSON serialization; the inspector reads them on
 * demand through the full per-task `Queries.GetTaskDetail`.
 *
 * The STORED task keeps the full fields — persistence
 * (`SessionManager.buildTaskPayload`), restore (`adoptByMetadata`), and
 * the MDXP task/list mapper all read from TaskManager directly and are
 * deliberately untouched by this projection.
 */
export function slimTaskForBroadcast(task: DownloadTask): DownloadTask {
  const bt = task.bt
  if (!bt) return task
  if (
    bt.trackers.length === 0 &&
    bt.announceList.length === 0 &&
    bt.magnetUri === null
  ) {
    return task
  }
  return {
    ...task,
    bt: { ...bt, trackers: [], announceList: [], magnetUri: null },
  }
}

export function slimTasksForBroadcast(
  tasks: readonly DownloadTask[]
): DownloadTask[] {
  return tasks.map(slimTaskForBroadcast)
}
