import { stat } from 'node:fs/promises'
import { getLogger } from '@core/logger'
import { AppError, ErrorCode } from '@shared/errors'
import { openTaskFilePayloadSchema } from '@shared/schemas/open-task-file'
import type { DownloadTask } from '@shared/types/task'
import { canOpenTaskFile } from '@shared/types/task-actions'
import { normalizeTaskOutputPath } from './task-output-path'

const log = getLogger('open-task-file')

interface OpenTaskFileDeps {
  platform?: NodeJS.Platform
  shell: { openPath: (path: string) => Promise<string> }
  getTask: (taskId: string) => DownloadTask | undefined
}

export function createOpenTaskFileHandler(deps: OpenTaskFileDeps) {
  return async (payload: unknown): Promise<void> => {
    const parsed = openTaskFilePayloadSchema.safeParse(payload)
    if (!parsed.success)
      throw new AppError(ErrorCode.IpcInvalidPayload, 'Invalid task id')
    const task = deps.getTask(parsed.data.taskId)
    if (!task) throw new AppError(ErrorCode.TaskNotFound, 'Task not found')
    if (!canOpenTaskFile(task))
      throw new AppError(ErrorCode.InvalidSelection, 'Task output is not ready')

    // Resolve only the task-owned published path, never a renderer-supplied path.
    const storedPath = task.finalPath || task.diskPath
    const outputPath = normalizeTaskOutputPath(
      storedPath,
      deps.platform ?? process.platform
    )
    let stage: 'stat' | 'recheck' | 'open' = 'stat'
    try {
      if (!(await stat(outputPath)).isFile())
        throw new Error('Task output is not a file')
      // Check again after the filesystem read in case the task was removed.
      stage = 'recheck'
      const current = deps.getTask(task.id)
      if (
        !current ||
        !canOpenTaskFile(current) ||
        (current.finalPath || current.diskPath) !== storedPath
      )
        throw new Error('Task output changed')
      stage = 'open'
      const error = await deps.shell.openPath(outputPath)
      if (error) throw new Error(error)
    } catch (cause) {
      log.warn(
        {
          err: cause,
          taskId: task.id,
          outputPath,
          finalPath: task.finalPath,
          diskPath: task.diskPath,
          stage,
        },
        'task_open_failed'
      )
      const detail = cause instanceof Error ? cause.message : String(cause)
      throw new AppError(
        stage === 'open'
          ? ErrorCode.TaskOpenAppFailed
          : ErrorCode.TaskOpenFailed,
        `Task output could not be opened: ${detail}`,
        cause
      )
    }
  }
}
