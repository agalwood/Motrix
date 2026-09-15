import { type DownloadTask, TaskStatus, TaskType } from '@shared/types/task'

export function getTaskSpeed(
  task: DownloadTask,
  field: 'downloadSpeed' | 'uploadSpeed'
): number | null {
  const speed = task[field]
  return task.status === TaskStatus.Completed ||
    task.status === TaskStatus.Finalizing ||
    !Number.isFinite(speed) ||
    speed <= 0
    ? null
    : speed
}

export function getTaskEta(task: DownloadTask): number | null {
  return task.status === TaskStatus.Paused ||
    task.status === TaskStatus.Completed ||
    task.status === TaskStatus.Finalizing ||
    !Number.isFinite(task.etaSeconds) ||
    task.etaSeconds <= 0
    ? null
    : task.etaSeconds
}

export function getTaskConnections(task: DownloadTask): number {
  return task.type === TaskType.Bt || task.type === TaskType.Magnet
    ? (task.bt?.peers ?? 0)
    : task.connections
}

export function getTaskTimestamp(
  task: DownloadTask,
  field: 'createdAt' | 'finishedAt'
): number | null {
  // finishedAt also records failures in the domain model. Only successful
  // completion belongs in the Completed column, matching the inspector.
  if (field === 'finishedAt' && task.status !== TaskStatus.Completed)
    return null
  const timestamp = task[field]
  return timestamp !== null &&
    timestamp > 0 &&
    Number.isFinite(new Date(timestamp).getTime())
    ? timestamp
    : null
}
