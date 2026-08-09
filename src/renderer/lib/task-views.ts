import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'

export type TaskView = 'active' | 'failed' | 'recent'

export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = Object.freeze([
  TaskStatus.Queued,
  TaskStatus.FetchingMetadata,
  TaskStatus.MetadataReady,
  TaskStatus.Downloading,
  TaskStatus.Finalizing,
  TaskStatus.Seeding,
  TaskStatus.Paused,
])

const ACTIVE_STATUS_ORDER: ReadonlyMap<TaskStatus, number> = new Map([
  [TaskStatus.MetadataReady, 0],
  [TaskStatus.Downloading, 1],
  [TaskStatus.FetchingMetadata, 2],
  [TaskStatus.Finalizing, 3],
  [TaskStatus.Seeding, 4],
  [TaskStatus.Queued, 5],
  [TaskStatus.Paused, 6],
])

function compareId(a: DownloadTask, b: DownloadTask): number {
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

function validTime(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null
}

function compareTimeDescending(a: number | null, b: number | null): number {
  const aTime = validTime(a)
  const bTime = validTime(b)
  if (aTime === null && bTime === null) return 0
  if (aTime === null) return 1
  if (bTime === null) return -1
  return bTime - aTime
}

function compareTimeAscending(a: number, b: number): number {
  const aTime = validTime(a)
  const bTime = validTime(b)
  if (aTime === null && bTime === null) return 0
  if (aTime === null) return 1
  if (bTime === null) return -1
  return aTime - bTime
}

export function taskMatchesView(task: DownloadTask, view: TaskView): boolean {
  switch (view) {
    case 'active':
      return ACTIVE_STATUS_ORDER.has(task.status)
    case 'failed':
      return task.status === TaskStatus.Error
    case 'recent':
      return task.status === TaskStatus.Completed
  }
}

export function compareActiveTasks(a: DownloadTask, b: DownloadTask): number {
  const statusDelta =
    (ACTIVE_STATUS_ORDER.get(a.status) ?? Number.MAX_SAFE_INTEGER) -
    (ACTIVE_STATUS_ORDER.get(b.status) ?? Number.MAX_SAFE_INTEGER)
  if (statusDelta !== 0) return statusDelta

  const priorityDelta = b.priority - a.priority
  if (priorityDelta !== 0) return priorityDelta

  const createdAtDelta = compareTimeAscending(a.createdAt, b.createdAt)
  if (createdAtDelta !== 0) return createdAtDelta

  return compareId(a, b)
}

export function compareFailedTasks(a: DownloadTask, b: DownloadTask): number {
  const terminalDelta = compareTimeDescending(a.finishedAt, b.finishedAt)
  if (terminalDelta !== 0) return terminalDelta

  const updatedAtDelta = compareTimeDescending(a.updatedAt, b.updatedAt)
  if (updatedAtDelta !== 0) return updatedAtDelta

  return compareId(a, b)
}

export function compareRecentTasks(a: DownloadTask, b: DownloadTask): number {
  const terminalDelta = compareTimeDescending(a.finishedAt, b.finishedAt)
  if (terminalDelta !== 0) return terminalDelta
  return compareId(a, b)
}

const COMPARATORS = {
  active: compareActiveTasks,
  failed: compareFailedTasks,
  recent: compareRecentTasks,
} satisfies Record<TaskView, (a: DownloadTask, b: DownloadTask) => number>

export interface TaskWindow {
  rows: DownloadTask[]
  total: number
}

function insertionIndex(
  rows: readonly DownloadTask[],
  task: DownloadTask,
  compare: (a: DownloadTask, b: DownloadTask) => number
): number {
  let low = 0
  let high = rows.length

  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const row = rows[middle]
    if (row && compare(row, task) <= 0) {
      low = middle + 1
    } else {
      high = middle
    }
  }

  return low
}

/**
 * Projects only the first `limit` rows while still counting every match.
 * Dashboard tile limits are small (at most eight), so retaining a bounded
 * sorted window avoids sorting an arbitrarily large task history on each
 * live update.
 */
export function projectTaskWindow(
  tasks: readonly DownloadTask[],
  view: TaskView,
  limit: number
): TaskWindow {
  const boundedLimit = Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : 0
  const compare = COMPARATORS[view]
  const rows: DownloadTask[] = []
  let total = 0

  for (const task of tasks) {
    if (!taskMatchesView(task, view)) continue
    total += 1
    if (boundedLimit === 0) continue

    const index = insertionIndex(rows, task, compare)
    if (index >= boundedLimit && rows.length >= boundedLimit) continue

    rows.splice(index, 0, task)
    if (rows.length > boundedLimit) rows.pop()
  }

  return { rows, total }
}

export function projectTasks(
  tasks: readonly DownloadTask[],
  view: TaskView
): DownloadTask[] {
  return tasks
    .filter((task) => taskMatchesView(task, view))
    .sort(COMPARATORS[view])
}
