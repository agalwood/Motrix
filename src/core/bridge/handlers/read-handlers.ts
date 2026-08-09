import {
  EngineStatusParamsSchema,
  type EngineStatusResult,
  Methods,
  StatsGetParamsSchema,
  type StatsResult,
  TaskGetParamsSchema,
  type TaskGetResult,
  TaskListParamsSchema,
  type TaskListResult,
} from '@motrix/mdxp'
import type { EngineFeatureReport, EngineState } from '@shared/types/engine'
import type { GlobalStats } from '@shared/types/stats'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { toMdxpTask, toMdxpTaskStatus } from '../mappers/download-task-to-mdxp'
import type { MdxpDispatcher } from '../mdxp-dispatcher'

/**
 * Structural dependencies for the v1 READ methods — intentionally narrow
 * interfaces (not the concrete manager classes) so the same registration runs
 * unchanged in the Electron and Node/server shells (Spec 6) and is trivial to
 * fake in tests.
 */
export interface ReadHandlerDeps {
  taskManager: {
    getAll(): DownloadTask[]
    getById(id: string): DownloadTask | undefined
  }
  statsAggregator: { getStats(): GlobalStats }
  supervisor: {
    getState(): EngineState
    getFeatureReport(): EngineFeatureReport | null
  }
}

/**
 * Register the v1 READ methods (`task/list`, `task/get`, `stats/get`,
 * `engine/status`) on a dispatcher. No new core logic — each is a thin
 * projection of an existing manager read through the `DownloadTask → MdxpTask`
 * mapper. These methods are agent-facing (unary `POST /mdxp` only); they are
 * deliberately NOT wired onto the extension WebSocket request surface.
 */
export function registerReadHandlers(
  dispatcher: MdxpDispatcher,
  deps: ReadHandlerDeps
): void {
  dispatcher.register(
    Methods.TaskList,
    TaskListParamsSchema,
    (params): TaskListResult => {
      const visible = deps.taskManager
        .getAll()
        .filter((t) => t.status !== TaskStatus.Removed)
      const filtered = params.status
        ? visible.filter((t) => toMdxpTaskStatus(t.status) === params.status)
        : visible
      const total = filtered.length
      const offset = params.offset ?? 0
      const end = params.limit != null ? offset + params.limit : undefined
      const tasks = filtered.slice(offset, end).map(toMdxpTask)
      return { tasks, total }
    }
  )

  dispatcher.register(
    Methods.TaskGet,
    TaskGetParamsSchema,
    (params): TaskGetResult => {
      const task = deps.taskManager.getById(params.taskId)
      if (!task || task.status === TaskStatus.Removed) return { task: null }
      return { task: toMdxpTask(task) }
    }
  )

  dispatcher.register(
    Methods.StatsGet,
    StatsGetParamsSchema,
    (): StatsResult => deps.statsAggregator.getStats()
  )

  dispatcher.register(
    Methods.EngineStatus,
    EngineStatusParamsSchema,
    (): EngineStatusResult => ({
      state: deps.supervisor.getState(),
      featureReport: deps.supervisor.getFeatureReport(),
    })
  )
}
