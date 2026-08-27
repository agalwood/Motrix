import path from 'node:path'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import { getLogger } from '@core/logger'
import type { MotrixDatabase } from '@core/session/motrix-database'
import {
  getBtPayloadPath,
  getBtStorageLayout,
} from '@core/task/bt-storage-layout'
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
  const layout = getBtStorageLayout(task)
  const payloadPath = getBtPayloadPath(task)
  if (
    layout &&
    !layout.multiFile &&
    payloadPath &&
    path.normalize(absolutePath) === path.normalize(payloadPath)
  ) {
    return layout.torrentRootName
  }
  return relativizeTorrentPath(
    absolutePath,
    payloadPath,
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

    // Magnet swaps in affected builds persisted selected-index placeholders
    // with empty paths and zero sizes. Treat those rows like an empty cache so
    // an available engine result can supply the real structure immediately;
    // the polling sync repairs the durable rows independently.
    const needsStructure =
      base.length === 0 || base.some((file) => file.path.length === 0)

    if (task.status === TaskStatus.Completed && !needsStructure) {
      for (const f of base) f.completedBytes = f.size
      return base
    }
    if (!ACTIVE_STATES.has(task.status) && !needsStructure) {
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
      // db is the source of structure (path/size/selected) once the auto-sync
      // has produced complete rows. Before that — an empty fresh-task cache
      // or legacy magnet placeholders — fall back to engine for the full
      // structure. Persistence remains owned by polling; this query is pure.
      if (needsStructure && live.length > 0) {
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
    if (task.status === TaskStatus.Completed) {
      for (const f of base) f.completedBytes = f.size
    }
    return base
  }
}
