import type { EngineAdapter } from '@core/engine/engine-adapter'
import { getLogger } from '@core/logger'
import type { MotrixDatabase } from '@core/session/motrix-database'
import type { TaskManager } from '@core/task/task-manager'
import { relativizeTorrentPath } from '@shared/lib/path-ext'
import type { DownloadTask, TaskFile } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'

const log = getLogger('TaskFilesProvider')

const ACTIVE_STATES = new Set<TaskStatus>([
  TaskStatus.Downloading,
  TaskStatus.Seeding,
  TaskStatus.FetchingMetadata,
])

interface Deps {
  db: Pick<MotrixDatabase, 'getTaskFiles'>
  taskManager: Pick<TaskManager, 'getById'>
  engine: Pick<EngineAdapter, 'getTaskFiles'>
}

function relativize(absolutePath: string, task: DownloadTask): string {
  return relativizeTorrentPath(
    absolutePath,
    task.diskPath,
    task.finalPath,
    task.saveDir
  )
}

export function createGetTaskFilesHandler(deps: Deps) {
  return async function getTaskFiles(taskId: string): Promise<TaskFile[]> {
    const task = deps.taskManager.getById(taskId)
    const base: TaskFile[] = deps.db.getTaskFiles(taskId).map((row) => ({
      index: row.fileIndex,
      path: task ? relativize(row.path, task) : row.path,
      size: row.size,
      selected: row.selected,
      completedBytes: 0,
    }))
    if (!task) return base

    if (task.status === TaskStatus.Completed) {
      for (const f of base) f.completedBytes = f.size
      return base
    }
    if (!ACTIVE_STATES.has(task.status)) {
      return base
    }
    // Coordinator-managed media tasks (Mux/Hls) have no aria2 handle
    // (engineTaskId ''); engine.getTaskFiles('') would just fail and log a
    // warning on every Files-tab open. Their per-file structure, if any, is
    // already in the db rows above — never call the engine with an empty gid.
    if (!task.engineTaskId) {
      return base
    }
    try {
      const live = await deps.engine.getTaskFiles(task.engineTaskId)
      // db is the source of structure (path/size/selected) once the
      // auto-sync trigger has run. Until then — i.e. on the first
      // GetTaskFiles call after a fresh task starts, before the poll
      // cycle has populated task_files — fall back to engine for the
      // full structure too. The persistence-side write happens out of
      // band in the poll handler; we don't side-effect from a query.
      if (base.length === 0 && live.length > 0) {
        return live.map((f) => ({
          index: f.index,
          path: relativize(f.path, task),
          size: f.size,
          selected: f.selected,
          completedBytes: f.completedBytes,
        }))
      }
      const byIndex = new Map(live.map((f) => [f.index, f.completedBytes]))
      for (const f of base) {
        f.completedBytes = byIndex.get(f.index) ?? 0
      }
    } catch (err) {
      log.warn({ err, taskId }, 'engine.getTaskFiles failed; degrading to 0')
    }
    return base
  }
}
