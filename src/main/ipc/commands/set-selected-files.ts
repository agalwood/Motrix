import type { EngineAdapter } from '@core/engine/engine-adapter'
import type { EventBus } from '@core/events/event-bus'
import { getLogger } from '@core/logger'
import type { MotrixDatabase } from '@core/session/motrix-database'
import type { TaskManager } from '@core/task/task-manager'
import { AppError, ErrorCode } from '@shared/errors'
import { Events } from '@shared/protocol/events'

const log = getLogger('SetSelectedFilesHandler')

interface Deps {
  taskManager: Pick<TaskManager, 'getById' | 'set'>
  engine: Pick<EngineAdapter, 'changeOption' | 'getTaskFiles'>
  db: Pick<MotrixDatabase, 'replaceTaskFiles'>
  eventBus: Pick<EventBus, 'emit'>
}

export function createSetSelectedFilesHandler(deps: Deps) {
  return async function setSelectedFiles(args: {
    taskId: string
    indices: number[]
  }): Promise<void> {
    if (args.indices.length === 0) {
      throw new AppError(
        ErrorCode.InvalidSelection,
        'At least one file must be selected'
      )
    }
    const task = deps.taskManager.getById(args.taskId)
    if (!task) {
      throw new AppError(
        ErrorCode.TaskNotFound,
        `Task ${args.taskId} not found`
      )
    }

    const selectFile = formatRange(args.indices)
    await deps.engine.changeOption(task.engineTaskId, {
      'select-file': selectFile,
    })

    const live = await deps.engine.getTaskFiles(task.engineTaskId)
    deps.db.replaceTaskFiles(
      args.taskId,
      live.map((f) => ({
        fileIndex: f.index,
        path: f.path,
        size: f.size,
        selected: f.selected,
      }))
    )

    if (task.bt) {
      deps.taskManager.set(args.taskId, {
        ...task,
        bt: { ...task.bt, selectedFiles: args.indices },
      })
    }
    deps.eventBus.emit(Events.TaskFilesUpdated, { taskId: args.taskId })
    log.info(
      { taskId: args.taskId, count: args.indices.length },
      'selected files updated'
    )
  }
}

/**
 * Convert 0-based indices to aria2 1-based comma-range form. Runs of three
 * or more consecutive values collapse to `start-end`; pairs stay
 * comma-separated:
 *   `[0, 1]`           -> `'1,2'`
 *   `[0, 2, 3, 4, 7]`  -> `'1,3-5,8'`
 */
export function formatRange(indices: number[]): string {
  if (indices.length === 0) return ''
  const sorted = [...indices].sort((a, b) => a - b).map((i) => i + 1)
  const parts: string[] = []
  let start = sorted[0] as number
  let prev = start
  const flush = () => {
    const length = prev - start + 1
    if (length >= 3) {
      parts.push(`${start}-${prev}`)
    } else {
      for (let v = start; v <= prev; v++) parts.push(`${v}`)
    }
  }
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i] as number
    if (cur === prev + 1) {
      prev = cur
    } else {
      flush()
      start = cur
      prev = cur
    }
  }
  flush()
  return parts.join(',')
}
