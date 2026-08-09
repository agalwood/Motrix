import type { DownloadTask } from '@shared/types/task'

/**
 * The engine gids currently held for a task — one per live instance. A
 * single-instance task (http / plain bt) yields `[task.engineTaskId]`;
 * multi-instance tasks (magnet metadata, HLS) carry several. The predicate is
 * gid-presence only (`gid != null`), matching every other engine-facing
 * consumer (`TaskManager.engineIndex`, `SessionManager.restore`): a non-null
 * gid is precisely "aria2 currently owns this download", independent of status
 * (a paused instance still owns its gid). Callers that want only actively
 * transferring gids filter by status on top of this primitive.
 *
 * This is the public-id → engine-gid translation `task/pause` / `task/resume`
 * fan out over: pausing "the task" pauses every live instance.
 */
export function liveInstanceGids(task: DownloadTask): string[] {
  const gids: string[] = []
  for (const instance of task.instances) {
    if (instance.gid != null) gids.push(instance.gid)
  }
  return gids
}
