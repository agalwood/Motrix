import { lstat } from 'node:fs/promises'
import { Commands } from '@shared/protocol/commands'
import type { CommandHandlerMap } from '@shared/protocol/handler-types'
import { btStorageRequestSchema } from '@shared/schemas/bt-storage'
import { taskIdsPayloadSchema } from '@shared/schemas/bulk-task-command'
import type { DownloadTask } from '@shared/types/task'
import { canResume } from '@shared/types/task-actions'
import { z } from 'zod'
import type { ServerDownloadPathPolicy } from '../../download-path-policy'
import type { FnosFiles } from './files'

/** Administrators share tasks; filesystem permissions still apply per request. */
export function guardFnosTaskCommands(
  handlers: CommandHandlerMap,
  files: FnosFiles,
  policy: ServerDownloadPathPolicy,
  getTasks: () => DownloadTask[]
) {
  const check = async (ids: string[]) => {
    for (const task of getTasks().filter((task) => ids.includes(task.id))) {
      await policy.prepareSaveDir(task.saveDir)
      const output = task.finalPath || task.diskPath
      const info = output
        ? await lstat(output).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined
            throw error
          })
        : undefined
      if (info) {
        const canonical = await files.authorizeFile(output, policy)
        await files.check(canonical, 'writable')
      }
    }
  }
  for (const channel of [
    Commands.ResumeTask,
    Commands.ResumeTasks,
    Commands.ResumeAllTasks,
    Commands.ReAddTask,
    Commands.ReAddTasks,
    Commands.RetryTasks,
  ]) {
    const original = handlers[channel]
    if (!original) continue
    handlers[channel] = async (...args) => {
      const ids =
        channel === Commands.ResumeAllTasks
          ? getTasks()
              .filter(canResume)
              .map((task) => task.id)
          : channel === Commands.ResumeTask || channel === Commands.ReAddTask
            ? [z.string().min(1).parse(args[0])]
            : taskIdsPayloadSchema.parse(args[0])
      await check(ids)
      return original(...args)
    }
  }
  const storage = handlers[Commands.ChangeBtStorage]
  if (storage)
    handlers[Commands.ChangeBtStorage] = async (...args) => {
      const input = btStorageRequestSchema.parse(args[0])
      await check([input.taskId])
      const task = getTasks().find((task) => task.id === input.taskId)
      if (input.mode === 'move' && task)
        await files.authorizeRemoval(task.finalPath || task.diskPath, policy)
      if (input.directory) await policy.prepareSaveDir(input.directory)
      return storage(...args)
    }
}
