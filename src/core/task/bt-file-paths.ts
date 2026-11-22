import path from 'node:path'
import { btFilePathsSchema } from '@shared/schemas/task-file-rename'
import type { DownloadTask, TaskFile } from '@shared/types/task'
import { getBtDirectStorageLayout } from './bt-storage-layout'

export function trackedBtFilePaths(task: Pick<DownloadTask, 'instances'>) {
  const paths = getBtDirectStorageLayout(task)?.filePaths
  return paths === undefined ? undefined : btFilePathsSchema.parse(paths)
}

function relativeFilePath(task: DownloadTask, file: TaskFile): string {
  const layout = getBtDirectStorageLayout(task)
  if (typeof layout?.multiFile !== 'boolean' || !path.isAbsolute(file.path))
    throw new Error('Invalid native file layout')
  const root = layout.multiFile ? task.finalPath : path.dirname(task.finalPath)
  const relative = path.relative(root, file.path)
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).some((part) => part === '..') ||
    (!layout.multiFile && path.dirname(file.path) !== root)
  )
    throw new Error('Native file left its payload root')
  return relative
}

function withPaths(
  task: DownloadTask,
  filePaths: Record<string, string>
): DownloadTask {
  return {
    ...task,
    instances: task.instances.map((instance) => {
      const layout = instance.payload.btStorageLayout
      if (
        !layout ||
        typeof layout !== 'object' ||
        !('strategy' in layout) ||
        layout.strategy !== 'direct'
      )
        return instance
      return {
        ...instance,
        payload: {
          ...instance.payload,
          btStorageLayout: { ...layout, filePaths },
        },
      }
    }),
  }
}

/** Record the current committed path before dispatch, never a speculative target. */
export function trackBtFilePath(
  task: DownloadTask,
  file: TaskFile
): DownloadTask {
  return withPaths(task, {
    ...trackedBtFilePaths(task),
    [file.index]: relativeFilePath(task, file),
  })
}

/** Engine bootstrap replays its rename journal before exposing this committed view. */
export function reconcileBtFilePaths(
  task: DownloadTask,
  files: readonly TaskFile[]
): DownloadTask {
  const paths = trackedBtFilePaths(task)
  if (!paths) return task
  const next = { ...paths }
  let singlePath: string | undefined
  const layout = getBtDirectStorageLayout(task)
  for (const file of files) {
    if (!(file.index in paths) || file.padding) continue
    next[file.index] = relativeFilePath(task, file)
    if (layout?.multiFile === false) singlePath = file.path
  }
  const changed =
    Object.keys(paths).some((key) => paths[key] !== next[key]) ||
    (singlePath !== undefined && singlePath !== task.finalPath)
  if (!changed) return task
  const updated = withPaths(task, next)
  if (singlePath) {
    updated.name =
      updated.filename =
      updated.finalName =
        path.basename(singlePath)
    updated.diskPath = updated.finalPath = singlePath
    const rebase = (value: unknown) =>
      value &&
      typeof value === 'object' &&
      'finalPath' in value &&
      value.finalPath === task.finalPath
        ? { ...value, finalPath: singlePath }
        : value
    updated.instances = updated.instances.map((instance) => ({
      ...instance,
      ...(instance.gid === task.engineTaskId ? { diskPath: singlePath } : {}),
      payload: {
        ...instance.payload,
        ...(instance.payload.btOutputReservation
          ? {
              btOutputReservation: rebase(instance.payload.btOutputReservation),
            }
          : {}),
        ...(Array.isArray(instance.payload.btOutputReservations)
          ? {
              btOutputReservations:
                instance.payload.btOutputReservations.map(rebase),
            }
          : {}),
      },
    }))
  }
  return updated
}
