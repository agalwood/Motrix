import type { EngineAdapter } from '@core/engine/engine-adapter'
import type { EventBus } from '@core/events/event-bus'
import { getLogger } from '@core/logger'
import type { MotrixDatabase } from '@core/session/motrix-database'
import type { TaskManager } from '@core/task/task-manager'
import { AppError, ErrorCode } from '@shared/errors'
import { Events } from '@shared/protocol/events'
import { setSelectedFilesPayloadSchema } from '@shared/schemas/task-file-selection'

const log = getLogger('SetSelectedFilesHandler')

interface Deps {
  taskManager: Pick<TaskManager, 'getById' | 'set'>
  engine: Pick<EngineAdapter, 'changeOption' | 'getTaskFiles'>
  db: Pick<MotrixDatabase, 'replaceTaskFiles'>
  eventBus: Pick<EventBus, 'emit'>
  runTaskMutation: <T>(
    taskIds: readonly string[],
    operation: () => Promise<T>
  ) => Promise<T>
}

export function createSetSelectedFilesHandler(deps: Deps) {
  return async function setSelectedFiles(rawPayload: unknown): Promise<void> {
    const parsed = setSelectedFilesPayloadSchema.safeParse(rawPayload)
    if (!parsed.success) {
      throw new AppError(
        ErrorCode.InvalidSelection,
        parsed.error.issues[0]?.message ?? 'Invalid file selection'
      )
    }
    const { taskId, indices } = parsed.data

    await deps.runTaskMutation([taskId], async () => {
      const task = deps.taskManager.getById(taskId)
      if (!task) {
        throw new AppError(ErrorCode.TaskNotFound, `Task ${taskId} not found`)
      }

      await deps.engine.changeOption(task.engineTaskId, {
        'select-file': formatRange(indices),
      })

      const live = await deps.engine.getTaskFiles(task.engineTaskId)
      deps.db.replaceTaskFiles(
        taskId,
        live.map((file) => ({
          fileIndex: file.index,
          path: file.path,
          size: file.size,
          selected: file.selected,
        }))
      )

      if (task.bt) {
        deps.taskManager.set(taskId, {
          ...task,
          bt: { ...task.bt, selectedFiles: indices },
        })
      }
      deps.eventBus.emit(Events.TaskFilesUpdated, { taskId })
      log.info({ taskId, count: indices.length }, 'selected files updated')
    })
  }
}

export function formatRange(indices: number[]): string {
  if (indices.length === 0) return ''
  const sorted = [...indices].sort((a, b) => a - b).map((index) => index + 1)
  const parts: string[] = []
  let start = sorted[0] as number
  let previous = start
  const flush = () => {
    const length = previous - start + 1
    if (length >= 3) {
      parts.push(`${start}-${previous}`)
    } else {
      for (let value = start; value <= previous; value++) {
        parts.push(`${value}`)
      }
    }
  }
  for (let index = 1; index < sorted.length; index++) {
    const current = sorted[index] as number
    if (current === previous + 1) {
      previous = current
    } else {
      flush()
      start = current
      previous = current
    }
  }
  flush()
  return parts.join(',')
}
