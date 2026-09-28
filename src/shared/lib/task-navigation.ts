import { TaskStatus } from '@shared/types/task'

export const ALL_DOWNLOADS_ROUTE = '/downloads/all'

export function isTaskAvailable(
  status: TaskStatus | null | undefined
): status is Exclude<TaskStatus, TaskStatus.Removed> {
  return status != null && status !== TaskStatus.Removed
}

/** Resolve against current state: links and notifications can outlive tasks. */
export function resolveTaskRoute(
  taskId: string,
  status: TaskStatus | null | undefined
): string {
  return isTaskAvailable(status)
    ? `${ALL_DOWNLOADS_ROUTE}?task=${encodeURIComponent(taskId)}`
    : ALL_DOWNLOADS_ROUTE
}
