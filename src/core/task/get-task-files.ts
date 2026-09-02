import path from 'node:path'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import { getLogger } from '@core/logger'
import type { MotrixDatabase } from '@core/session/motrix-database'
import {
  getBtPayloadPath,
  getBtStorageLayout,
} from '@core/task/bt-storage-layout'
import { toFinalPath } from '@core/task/paths'
import type { TaskManager } from '@core/task/task-manager'
import { relativizeTorrentPath } from '@shared/lib/path-ext'
import type { DownloadTask, TaskFile } from '@shared/types/task'
import { TaskKind, TaskStatus, TaskType } from '@shared/types/task'

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

function toDisplayPath(physicalPath: string, task: DownloadTask): string {
  const relativePath = relativize(physicalPath, task)
  if (
    task.kind === TaskKind.Direct &&
    (task.type === TaskType.Http || task.type === TaskType.Ftp)
  ) {
    if (task.finalName) return task.finalName
    return toFinalPath(relativePath)
  }
  return relativePath
}

export function createGetTaskFilesHandler(deps: Deps) {
  return async function getTaskFiles(taskId: string): Promise<TaskFile[]> {
    const task = deps.taskManager.getById(taskId)
    const base: TaskFile[] = deps.db.getTaskFiles(taskId).map((row) => ({
      index: row.fileIndex,
      path: task ? toDisplayPath(row.path, task) : row.path,
      size: row.size,
      selected: row.selected,
      completedBytes: 0,
    }))
    if (!task) return base

    const needsStructure =
      base.length === 0 || base.some((file) => file.path.length === 0)

    if (task.status === TaskStatus.Completed && !needsStructure) {
      for (const file of base) file.completedBytes = file.size
      return base
    }
    if (!ACTIVE_STATES.has(task.status) && !needsStructure) return base
    if (!task.engineTaskId) return base

    try {
      const live = await deps.engine.getTaskFiles(task.engineTaskId)
      if (needsStructure && live.length > 0) {
        return live.map((file) => ({
          index: file.index,
          path: toDisplayPath(file.path, task),
          size: file.size,
          selected: file.selected,
          completedBytes: file.completedBytes,
        }))
      }
      const byIndex = new Map(
        live.map((file) => [file.index, file.completedBytes])
      )
      for (const file of base) {
        file.completedBytes = byIndex.get(file.index) ?? 0
      }
    } catch (error) {
      log.warn(
        { err: error, taskId },
        'engine.getTaskFiles failed; degrading to 0'
      )
    }
    if (task.status === TaskStatus.Completed) {
      for (const file of base) file.completedBytes = file.size
    }
    return base
  }
}
