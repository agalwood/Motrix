import {
  DownloadAddParamsSchema,
  ErrorCodes,
  type MdxpTask,
  Methods,
  makeMdxpError,
  type OkResult,
  TaskPauseParamsSchema,
  TaskRemoveParamsSchema,
  TaskResumeParamsSchema,
} from '@motrix/mdxp'
import type { TaskCreateRequest } from '@shared/schemas/add-task'
import type { DownloadTask } from '@shared/types/task'
import { buildCreateRequest } from '../mappers/download-add-to-create-request'
import { toMdxpTask } from '../mappers/download-task-to-mdxp'
import type { MdxpDispatcher } from '../mdxp-dispatcher'

/**
 * Structural dependencies for the v1 WRITE methods. Closures (not concrete
 * managers) so the same registration runs in both shells and is trivial to
 * fake. Pause/resume are deliberately public-id actions: the core action owns
 * engine/media fan-out, durable publication, and transition recording.
 * `removeTask` keys by public id and honors `deleteFiles`; `createTask` +
 * `parseTorrentFileCount` back `download/add`.
 */
export interface WriteHandlerDeps {
  taskManager: { getById(id: string): DownloadTask | undefined }
  pauseTask: (taskId: string) => Promise<void>
  resumeTask: (taskId: string) => Promise<void>
  removeTask: (taskId: string, opts: { deleteFiles: boolean }) => Promise<void>
  /** Create a native task (handleCreateTask, bound to the shell's deps). */
  createTask: (req: TaskCreateRequest) => Promise<{ taskId: string }>
  /** File count of a base64 torrent — for the torrent select-all default. */
  parseTorrentFileCount: (base64: string) => Promise<number>
}

const OK: OkResult = { ok: true }

/** Resolve a task by public id or throw ResourceUnavailable (explicit feedback
 *  for an agent, vs. the core action's silent no-op on a missing id). */
function requireTask(
  deps: { taskManager: { getById(id: string): DownloadTask | undefined } },
  taskId: string
): DownloadTask {
  const task = deps.taskManager.getById(taskId)
  if (!task) {
    throw makeMdxpError(
      ErrorCodes.ResourceUnavailable,
      `task not found: ${taskId}`
    )
  }
  return task
}

/** Register `task/pause`, `task/resume`, `task/remove`, `download/add`. */
export function registerWriteHandlers(
  dispatcher: MdxpDispatcher,
  deps: WriteHandlerDeps
): void {
  dispatcher.register(
    Methods.TaskPause,
    TaskPauseParamsSchema,
    async (params): Promise<OkResult> => {
      requireTask(deps, params.taskId)
      await deps.pauseTask(params.taskId)
      return OK
    }
  )

  dispatcher.register(
    Methods.TaskResume,
    TaskResumeParamsSchema,
    async (params): Promise<OkResult> => {
      requireTask(deps, params.taskId)
      await deps.resumeTask(params.taskId)
      return OK
    }
  )

  dispatcher.register(
    Methods.TaskRemove,
    TaskRemoveParamsSchema,
    async (params): Promise<OkResult> => {
      requireTask(deps, params.taskId)
      await deps.removeTask(params.taskId, {
        deleteFiles: params.deleteFiles ?? false,
      })
      return OK
    }
  )

  dispatcher.register(
    Methods.DownloadAdd,
    DownloadAddParamsSchema,
    async (params): Promise<MdxpTask> => {
      const req = await buildCreateRequest(params, deps.parseTorrentFileCount)
      const { taskId } = await deps.createTask(req)
      // handleCreateTask registers the task synchronously, so getById should
      // resolve immediately; a miss means the create path is broken.
      const task = deps.taskManager.getById(taskId)
      if (!task) {
        throw makeMdxpError(
          ErrorCodes.AdapterError,
          `created task not retrievable: ${taskId}`
        )
      }
      return toMdxpTask(task)
    }
  )
}
