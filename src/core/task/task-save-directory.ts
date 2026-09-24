import path from 'node:path'
import type { TaskInstanceRow, TaskRow } from '@core/session/motrix-database'
import { TaskInstancePhase } from '@shared/types/task'
import { isTorrentLikeType } from '@shared/types/task-actions'
import { btWorkspacePath, getBtStorageLayout } from './bt-storage-layout'

/** Restore the user-selected root, independently of engine and output paths. */
export function restoreTaskSaveDirectory(
  task: TaskRow,
  instances: readonly TaskInstanceRow[],
  engineDirectory?: string
): string {
  if (task.saveDir && path.isAbsolute(task.saveDir)) return task.saveDir
  const primary = instances[0]
  if (isTorrentLikeType(task.taskType)) {
    // In-flight instances point at the workspace; completed instances retain
    // its layout even after diskPath has moved to a plugin-selected target.
    const workspaces = [primary?.diskPath, engineDirectory]
    for (const instance of instances) {
      const layout = instance.payload.btStorageLayout
      if (layout && typeof layout === 'object' && 'workspacePath' in layout) {
        const workspace = layout.workspacePath
        if (typeof workspace === 'string') workspaces.push(workspace)
      }
    }
    for (const workspace of workspaces) {
      if (!workspace || !path.isAbsolute(workspace)) continue
      const root = path.dirname(path.dirname(workspace))
      if (
        path.resolve(btWorkspacePath(task.motrixId, root)) !==
        path.resolve(workspace)
      )
        continue
      if (
        workspace === primary?.diskPath ||
        workspace === engineDirectory ||
        getBtStorageLayout({
          saveDir: root,
          diskPath: primary?.diskPath ?? '',
          finalPath: task.finalPath,
          instances: [...instances],
        })
      )
        return root
    }
    // Before metadata resolution finalPath is the selected directory itself.
    if (primary?.phase === TaskInstancePhase.MagnetMetadataResolution) {
      return task.finalPath || engineDirectory || ''
    }
  }
  if (engineDirectory && path.isAbsolute(engineDirectory))
    return engineDirectory
  const output =
    primary?.phase === TaskInstancePhase.HttpDownload ||
    primary?.phase === TaskInstancePhase.BtDownload
      ? primary.diskPath || task.finalPath
      : task.finalPath || primary?.diskPath
  return output ? path.dirname(output) : ''
}
