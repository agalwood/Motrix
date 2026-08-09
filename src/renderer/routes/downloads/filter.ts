import type { DownloadTask } from '@shared/types/task'
import { TaskStatus, TaskType } from '@shared/types/task'
import { taskMatchesView } from '../../lib/task-views'

export const DOWNLOADS_TABS = ['all', 'active', 'completed', 'error'] as const
export type DownloadsTab = (typeof DOWNLOADS_TABS)[number]

export const isValidTab = (x: unknown): x is DownloadsTab =>
  typeof x === 'string' && (DOWNLOADS_TABS as readonly string[]).includes(x)

export function taskMatchesTab(task: DownloadTask, tab: DownloadsTab): boolean {
  switch (tab) {
    case 'all':
      return task.status !== TaskStatus.Removed
    case 'active':
      return taskMatchesView(task, 'active')
    case 'completed':
      return task.status === TaskStatus.Completed
    case 'error':
      return task.status === TaskStatus.Error
  }
}

/** Main-list filter: tab + protocol type. Search is NOT part of this. */
export function applyFilter(
  tasks: readonly DownloadTask[],
  tab: DownloadsTab,
  types: readonly TaskType[]
): readonly DownloadTask[] {
  return tasks.filter((t) => {
    if (!taskMatchesTab(t, tab)) return false
    if (types.length === 0) return true
    return types.includes(t.type)
  })
}

export function countTasksByTab(
  tasks: readonly DownloadTask[]
): Record<DownloadsTab, number> {
  const counts: Record<DownloadsTab, number> = {
    all: 0,
    active: 0,
    completed: 0,
    error: 0,
  }
  for (const t of tasks) {
    for (const tab of DOWNLOADS_TABS) {
      if (taskMatchesTab(t, tab)) counts[tab]++
    }
  }
  return counts
}

const ALL_TYPES: readonly TaskType[] = [
  TaskType.Http,
  TaskType.Ftp,
  TaskType.Bt,
  TaskType.Magnet,
  TaskType.Metalink,
]

export function countTasksByType(
  tasks: readonly DownloadTask[]
): Record<TaskType, number> {
  const counts = {
    [TaskType.Http]: 0,
    [TaskType.Ftp]: 0,
    [TaskType.Bt]: 0,
    [TaskType.Magnet]: 0,
    [TaskType.Metalink]: 0,
  } as Record<TaskType, number>
  for (const t of tasks) {
    if (t.status === TaskStatus.Removed) continue
    counts[t.type]++
  }
  return counts
}

const isTaskType = (x: string): x is TaskType =>
  (ALL_TYPES as readonly string[]).includes(x)

/** Parse `?type=http,bt` into a de-duped, validated TaskType[]. */
export function parseTypeParam(value: string | null): TaskType[] {
  if (!value) return []
  const out: TaskType[] = []
  for (const raw of value.split(',')) {
    const v = raw.trim()
    if (isTaskType(v) && !out.includes(v)) out.push(v)
  }
  return out
}

export function serializeTypeParam(types: readonly TaskType[]): string {
  return types.join(',')
}

function normalize(s: string): string {
  return s.normalize('NFC').toLowerCase()
}

/** Finder match used by FilterSearchPanel (NOT by applyFilter). */
export function taskMatchesQuery(task: DownloadTask, needle: string): boolean {
  const n = normalize(needle.trim())
  if (!n) return true
  const hay = [task.name, task.uris[0] ?? '', task.category ?? '']
    .map(normalize)
    .join(' ')
  return hay.includes(n)
}
