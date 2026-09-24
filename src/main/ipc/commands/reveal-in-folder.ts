import { stat } from 'node:fs/promises'
import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'
import type { DownloadTask } from '@shared/types/task'

export interface RevealInFolderDeps {
  shell: {
    showItemInFolder: (path: string) => void
    openPath: (path: string) => Promise<string>
  }
  getTask: (
    taskId: string
  ) => Pick<DownloadTask, 'diskPath' | 'finalPath'> | undefined
}

export interface RevealInFolderPayload {
  taskId: string
}

function isWindowsDeviceNamespace(value: string): boolean {
  const normalized = value.replaceAll('\\', '/')
  return (
    normalized.startsWith('//?/') ||
    normalized.startsWith('//./') ||
    normalized.startsWith('/??/') ||
    normalized.startsWith('//??/')
  )
}

export function createRevealInFolderHandler(deps: RevealInFolderDeps) {
  return async (payload: RevealInFolderPayload): Promise<void> => {
    const taskId = payload?.taskId
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw new AppError(
        ErrorCode.IpcInvalidPayload,
        'revealInFolder: invalid task id'
      )
    }

    const task = deps.getTask(taskId)
    if (!task) {
      throw new AppError(ErrorCode.TaskNotFound, `Task not found: ${taskId}`)
    }

    // Indexed BT downloads intentionally live in an internal
    // `.motrix/<workspace>/p` staging tree until finalization. Revealing that
    // path leaks an implementation identifier and disagrees with the target
    // path shown by the Inspector, so user-facing navigation follows the
    // stable final destination whenever one is known.
    const taskPath = task.finalPath || task.diskPath
    if (
      typeof taskPath !== 'string' ||
      taskPath.trim() === '' ||
      taskPath.includes('\0') ||
      (!path.isAbsolute(taskPath) && !path.win32.isAbsolute(taskPath)) ||
      isWindowsDeviceNamespace(taskPath)
    ) {
      throw new AppError(
        ErrorCode.IpcInvalidPayload,
        'revealInFolder: task has an invalid path'
      )
    }

    try {
      const output = await stat(taskPath).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        }
      )
      if (output !== null) {
        deps.shell.showItemInFolder(taskPath)
        return
      }

      // Incomplete outputs can still have a .motrix suffix or live in a BT
      // workspace. showItemInFolder silently fails for their absent final
      // path, so open its containing directory until the output is published.
      const pathApi = path.posix.isAbsolute(taskPath) ? path.posix : path.win32
      const directory = pathApi.dirname(taskPath)
      if (!(await stat(directory)).isDirectory()) {
        throw new Error('task parent is not a directory')
      }
      const error = await deps.shell.openPath(directory)
      if (error) throw new Error(error)
    } catch (cause) {
      throw new AppError(
        ErrorCode.TaskRevealFailed,
        'revealInFolder: task output cannot be revealed',
        cause
      )
    }
  }
}
