import { getTaskOrWarn, type TaskActionDeps } from './shared'

export type MoveDirection = 'up' | 'down'

export async function moveTask(
  taskId: string,
  direction: MoveDirection,
  deps: TaskActionDeps
): Promise<void> {
  const task = getTaskOrWarn(deps, taskId, 'moveTask')
  if (!task) return
  const shift = direction === 'up' ? -1 : 1
  try {
    await deps.adapter.changePosition(task.engineTaskId, shift, 'POS_CUR')
  } catch (err) {
    // Out-of-range errors are non-fatal; next polling tick refreshes position flags.
    deps.log.warn(
      { taskId, direction, err: String(err) },
      'moveTask: engine rejected position change'
    )
  }
}
