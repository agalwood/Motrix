import { type DownloadTask, TaskStatus } from '@shared/types/task'
import { z } from 'zod'
import {
  getTaskConnections,
  getTaskEta,
  getTaskSpeed,
  getTaskTimestamp,
} from './task-column-values'

export const TASK_SORT_COLUMNS = [
  'name',
  'size',
  'progress',
  'status',
  'down',
  'up',
  'eta',
  'connections',
  'createdAt',
  'finishedAt',
] as const

export type TaskSortColumn = (typeof TASK_SORT_COLUMNS)[number]
export const TaskSortSchema = z
  .object({
    column: z.enum(TASK_SORT_COLUMNS),
    direction: z.enum(['asc', 'desc']),
  })
  .nullable()
export type TaskSort = z.infer<typeof TaskSortSchema>
export type TaskSortDirection = NonNullable<TaskSort>['direction']

export const DEFAULT_TASK_SORT: NonNullable<TaskSort> = {
  column: 'createdAt',
  direction: 'desc',
}

const DEFAULT_DIRECTION: Record<TaskSortColumn, TaskSortDirection> = {
  name: 'asc',
  size: 'desc',
  progress: 'desc',
  status: 'asc',
  down: 'desc',
  up: 'desc',
  eta: 'asc',
  connections: 'desc',
  createdAt: 'desc',
  finishedAt: 'desc',
}

// Lifecycle order keeps related states together regardless of UI language.
const STATUS_ORDER: Record<TaskStatus, number> = {
  [TaskStatus.Queued]: 0,
  [TaskStatus.FetchingMetadata]: 1,
  [TaskStatus.MetadataReady]: 2,
  [TaskStatus.Downloading]: 3,
  [TaskStatus.Finalizing]: 4,
  [TaskStatus.Seeding]: 5,
  [TaskStatus.Paused]: 6,
  [TaskStatus.Completed]: 7,
  [TaskStatus.Error]: 8,
  [TaskStatus.Removed]: 9,
}

export function nextTaskSort(
  sort: TaskSort,
  column: TaskSortColumn
): NonNullable<TaskSort> {
  const direction = DEFAULT_DIRECTION[column]
  if (sort?.column !== column) return { column, direction }
  return { column, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
}

function numericValue(
  task: DownloadTask,
  column: Exclude<TaskSortColumn, 'name'>
): number | null {
  switch (column) {
    case 'size':
      return task.sizeWhenDone
    case 'progress':
      return Math.max(0, Math.min(1, task.progress))
    case 'status':
      return STATUS_ORDER[task.status]
    case 'down':
      return getTaskSpeed(task, 'downloadSpeed')
    case 'up':
      return getTaskSpeed(task, 'uploadSpeed')
    case 'eta':
      return getTaskEta(task)
    case 'connections':
      return getTaskConnections(task)
    case 'createdAt':
    case 'finishedAt':
      return getTaskTimestamp(task, column)
  }
}

export function sortTasks(
  tasks: readonly DownloadTask[],
  sort: TaskSort,
  locale: string
): readonly DownloadTask[] {
  const { column, direction } = sort ?? DEFAULT_TASK_SORT
  const multiplier = direction === 'asc' ? 1 : -1
  if (column === 'name') {
    const collator = new Intl.Collator(locale, {
      numeric: true,
      sensitivity: 'base',
    })
    return [...tasks].sort(
      (a, b) => collator.compare(a.name, b.name) * multiplier
    )
  }

  // Sort a copy and retain the source order for equal values. The default
  // ordering also applies to new tasks appended to a live snapshot.
  return [...tasks].sort((a, b) => {
    const left = numericValue(a, column)
    const right = numericValue(b, column)
    const leftMissing = left === null || !Number.isFinite(left)
    const rightMissing = right === null || !Number.isFinite(right)
    // Dashes and unavailable estimates stay last in either direction.
    if (leftMissing) return rightMissing ? 0 : 1
    if (rightMissing) return -1
    return (left - right) * multiplier
  })
}
