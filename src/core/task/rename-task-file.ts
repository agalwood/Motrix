import path from 'node:path'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import type { DurableFinalizeRuntime } from '@core/session/durable-finalize-runtime'
import { AppError, ErrorCode } from '@shared/errors'
import { taskFileRenameSchema } from '@shared/schemas/task-file-rename'
import type { DownloadTask, TaskFile } from '@shared/types/task'
import { canRenameTaskFiles } from '@shared/types/task-actions'
import { withBtOutputAdmissions } from './bt-duplicate-policy'
import { reconcileBtFilePaths, trackBtFilePath } from './bt-file-paths'
import { hasReservedTaskOutput } from './bt-output-reservation'
import type { BtStorageServiceDeps } from './bt-storage-service'
import type { NativeArtifactMutation } from './native-artifact-mutation'
import type { TaskManager } from './task-manager'

interface Deps {
  taskManager: Pick<TaskManager, 'getById' | 'getAll' | 'set'>
  engine: Pick<EngineAdapter, 'getTaskFiles' | 'renameTaskFile'>
  runTaskMutation<T>(
    ids: readonly string[],
    operation: () => Promise<T>
  ): Promise<T>
  nativeFileMutation?: NativeArtifactMutation
  persistTask?: (task: DownloadTask) => Promise<void>
  persistTaskFiles?: (
    task: DownloadTask,
    files: readonly TaskFile[]
  ) => Promise<void>
  runtime?: Pick<
    DurableFinalizeRuntime,
    'withArtifactLease' | 'hasPendingFinalization'
  >
  authorizeTaskWrite?: (task: DownloadTask) => Promise<void>
  authorizeOutputWrite?: (target: string) => Promise<void>
  prepareStorageBinding?: BtStorageServiceDeps['prepareStorageBinding']
  publishTaskUpdate: () => void
  publishFiles: (taskId: string) => void
}

export function createRenameTaskFileHandler(deps: Deps) {
  return async (raw: unknown): Promise<void> => {
    const parsed = taskFileRenameSchema.safeParse(raw)
    if (!parsed.success)
      throw new AppError(ErrorCode.InvalidSelection, 'task.fileRename.invalid')
    const request = parsed.data
    const nativeMutation = deps.nativeFileMutation
    const persistMarker = deps.persistTask
    const persist = deps.persistTaskFiles
    const rename = deps.engine.renameTaskFile?.bind(deps.engine)
    if (!persist || !persistMarker || !rename || !nativeMutation)
      throw new AppError(
        ErrorCode.EngineFeatureUnavailable,
        'task.fileRename.unavailable'
      )
    const admissionPath = deps.taskManager.getById(request.taskId)?.finalPath
    if (!admissionPath)
      throw new AppError(
        ErrorCode.InvalidSelection,
        'task.fileRename.unavailable'
      )
    await withBtOutputAdmissions([path.dirname(admissionPath)], () =>
      deps.runTaskMutation([request.taskId], async () => {
        const execute = async () => {
          const owned = () => {
            const task = deps.taskManager.getById(request.taskId)
            if (!task || task.engineTaskId !== request.engineTaskId)
              throw new AppError(
                ErrorCode.InvalidSelection,
                'task.fileRename.changed'
              )
            return task
          }
          const initial = owned()
          if (
            initial.finalPath !== admissionPath ||
            !canRenameTaskFiles(initial) ||
            (await deps.runtime?.hasPendingFinalization(initial.id))
          )
            throw new AppError(
              ErrorCode.InvalidSelection,
              'task.fileRename.unavailable'
            )
          await deps.authorizeTaskWrite?.(initial)
          const files = await deps.engine.getTaskFiles(request.engineTaskId)
          const file = files.find((entry) => entry.index === request.fileIndex)
          if (
            !file ||
            file.padding ||
            path.basename(file.path) !== request.expectedName
          )
            throw new AppError(
              ErrorCode.InvalidSelection,
              'task.fileRename.changed'
            )
          if (request.name === request.expectedName) return
          const target = path.join(path.dirname(file.path), request.name)
          if (
            hasReservedTaskOutput(
              deps.taskManager.getAll(),
              [target],
              initial.id
            )
          )
            throw new AppError(
              ErrorCode.InvalidSelection,
              'task.fileRename.conflict'
            )
          await deps.authorizeOutputWrite?.(target)
          const current = owned()
          if (!canRenameTaskFiles(current))
            throw new AppError(
              ErrorCode.InvalidSelection,
              'task.fileRename.unavailable'
            )
          const tracked = trackBtFilePath(current, file)
          const projectedFiles = files.map((entry) =>
            entry.index === file.index ? { ...entry, path: target } : entry
          )
          const projected = reconcileBtFilePaths(tracked, projectedFiles)
          const binding = await deps.prepareStorageBinding?.(
            projected,
            'move',
            projectedFiles
              .filter((entry) => entry.selected && !entry.padding)
              .map((entry) => entry.path)
          )
          // The engine owns the filesystem journal. This durable marker makes a
          // committed engine rename discoverable after an interrupted host reply.
          await persistMarker(tracked)
          deps.taskManager.set(tracked.id, {
            ...tracked,
            storageOperation: true,
          })
          deps.publishTaskUpdate()
          try {
            await nativeMutation(request.taskId, async () => {
              const committed = await rename(
                request.engineTaskId,
                file.index,
                file.path,
                target
              )
              const updated = reconcileBtFilePaths(owned(), committed)
              delete updated.storageOperation
              // Keep the authoritative path visible even if host persistence fails;
              // the tracking marker repairs the database on the next startup.
              deps.taskManager.set(updated.id, updated)
              await binding?.bindMoved()
              await persist(updated, committed)
              deps.publishFiles(updated.id)
            })
          } finally {
            const latest = deps.taskManager.getById(request.taskId)
            if (
              latest?.engineTaskId === request.engineTaskId &&
              latest.storageOperation
            ) {
              const settled = { ...latest }
              delete settled.storageOperation
              deps.taskManager.set(settled.id, settled)
            }
            deps.publishTaskUpdate()
          }
        }
        await execute()
      })
    )
  }
}
