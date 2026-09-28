import { AppError, ErrorCode } from '@shared/errors'
import type {
  MoveTasksPayload,
  MoveTasksResult,
} from '@shared/schemas/move-tasks'
import { canMoveInQueue } from '@shared/types/task-actions'
import type { EngineAdapter } from '../../engine/engine-adapter'
import type { TaskActionDeps } from './shared'

// Queue order is shared by all tasks, so even disjoint batches serialize.
const pendingMoves = new WeakMap<EngineAdapter, Promise<unknown>>()

export async function moveTasks(
  payload: MoveTasksPayload,
  deps: TaskActionDeps
): Promise<MoveTasksResult> {
  const previous = pendingMoves.get(deps.adapter) ?? Promise.resolve()
  const operation = previous
    .catch(() => {})
    .then(() => moveBatch(payload, deps))
  pendingMoves.set(deps.adapter, operation)
  try {
    return await operation
  } finally {
    if (pendingMoves.get(deps.adapter) === operation)
      pendingMoves.delete(deps.adapter)
  }
}

async function moveBatch(
  { taskIds, direction }: MoveTasksPayload,
  deps: TaskActionDeps
): Promise<MoveTasksResult> {
  const ids = [...new Set(taskIds)]
  const result: MoveTasksResult = { moved: [], unchanged: [], failed: [] }
  const tasks = ids
    .map((id) => {
      const task = deps.taskManager.getById(id)
      if (!task || !canMoveInQueue(task)) {
        result.failed.push({ taskId: id, reason: 'not-waiting' })
        return null
      }
      return task
    })
    .filter((task) => task !== null)
  if (!tasks.length) return result
  const shift = direction === 'up' || direction === 'top' ? -1 : 1
  const toEdge = direction === 'top' || direction === 'bottom'
  const initial = await deps.adapter.listWaitingTaskIds()
  const positions = new Map(initial.map((id, index) => [id, index]))
  const selected = new Set(tasks.map((task) => task.engineTaskId))
  tasks.sort(
    (a, b) =>
      ((positions.get(a.engineTaskId) ?? -1) -
        (positions.get(b.engineTaskId) ?? -1)) *
      -shift
  )

  for (const task of tasks) {
    const move = async () => {
      const current = deps.taskManager.getById(task.id)
      if (
        !current ||
        !canMoveInQueue(current) ||
        current.engineTaskId !== task.engineTaskId
      )
        throw new AppError(ErrorCode.InvalidSelection, 'not-waiting')
      // Refresh before each move: downloads may start while the menu is open
      // or while earlier members of this batch are being moved.
      const queue = await deps.adapter.listWaitingTaskIds()
      const index = queue.indexOf(current.engineTaskId)
      if (index < 0)
        throw new AppError(ErrorCode.InvalidSelection, 'not-waiting')
      let destination = index + shift
      if (toEdge) {
        destination = index
        // Stop at the nearest selected task, including one whose move failed.
        // This preserves the batch's relative order even after partial failure.
        while (
          queue[destination + shift] &&
          !selected.has(queue[destination + shift])
        )
          destination += shift
      }
      if (
        destination === index ||
        !queue[destination] ||
        selected.has(queue[destination])
      ) {
        result.unchanged.push(task.id)
        return
      }
      const position = await deps.adapter.changePosition(
        current.engineTaskId,
        toEdge ? destination : shift,
        toEdge ? 'POS_SET' : 'POS_CUR'
      )
      ;(position === index ? result.unchanged : result.moved).push(task.id)
    }
    try {
      await (deps.runTaskMutation
        ? deps.runTaskMutation([task.id], move)
        : move())
    } catch (error) {
      deps.log.warn(
        { taskId: task.id, direction, error },
        'Waiting queue move failed'
      )
      result.failed.push({
        taskId: task.id,
        reason:
          error instanceof AppError && error.code === ErrorCode.InvalidSelection
            ? 'not-waiting'
            : 'engine-rejected',
      })
    }
  }
  return result
}
