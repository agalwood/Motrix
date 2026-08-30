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
  TaskRevealParamsSchema,
} from '@motrix/mdxp'
import { clientKey } from '@shared/protocol/bridge'
import type { TaskCreateRequest } from '@shared/schemas/add-task'
import type { DownloadTask } from '@shared/types/task'
import { IdempotencyCache } from '../idempotency-cache'
import { buildCreateRequest } from '../mappers/download-add-to-create-request'
import { toMdxpTask } from '../mappers/download-task-to-mdxp'
import type { MdxpDispatcher } from '../mdxp-dispatcher'

/**
 * Structural dependencies for the v1 WRITE methods. Closures (not concrete
 * managers) so the same registration runs in both shells and is trivial to
 * fake. Pause/resume are deliberately public-id actions: the core action owns
 * engine/media fan-out, durable publication, and transition recording.
 * `removeTask` keys by public id and honors `deleteFiles`; `createTask` +
 * `parseTorrentFileCount` back `download/add`. `revealTask` is an optional
 * Electron-shell capability: the headless server deliberately omits it.
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
  /** Reveal a task-owned output in the platform file manager. */
  revealTask?: (taskId: string) => Promise<void>
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

/** Register the v1 write surface, including optional shell capabilities. */
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

  if (deps.revealTask) {
    const revealTask = deps.revealTask
    dispatcher.register(
      Methods.TaskReveal,
      TaskRevealParamsSchema,
      async (params): Promise<OkResult> => {
        // Resolve the public id before crossing into the shell. The protocol
        // never accepts a caller-supplied path; the Electron handler derives
        // the destination from this trusted task record.
        requireTask(deps, params.taskId)
        try {
          await revealTask(params.taskId)
        } catch {
          // Shell/OS errors can contain an absolute path. Keep that detail out
          // of the remote response and expose only the capability-level fact.
          throw makeMdxpError(
            ErrorCodes.ResourceUnavailable,
            'task output cannot be revealed'
          )
        }
        return OK
      }
    )
  }

  // Keyed replays (lost response, prompt retry) must return the first
  // submission's snapshot instead of minting a second task. Scoped by
  // clientKey so identities can never share a dedup namespace. Keyless
  // adds keep the direct path (backward compatible).
  const addsByKey = new IdempotencyCache<MdxpTask>()
  dispatcher.register(
    Methods.DownloadAdd,
    DownloadAddParamsSchema,
    async (params, ctx): Promise<MdxpTask> => {
      const createAndSnapshot = async (): Promise<MdxpTask> => {
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
      const key = params.idempotencyKey
      if (!key) return createAndSnapshot()
      return addsByKey.run(
        JSON.stringify([clientKey(ctx.identity), key]),
        createAndSnapshot
      )
    }
  )
}
