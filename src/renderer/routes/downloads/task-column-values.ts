import { type DownloadTask, TaskStatus, TaskType } from '@shared/types/task'
import {
  getTransferMetrics,
  isMediaProcessing,
  isMediaTask,
} from '@shared/utils/media-progress'

export function isTaskSpeedApplicable(
  task: DownloadTask,
  field: 'downloadSpeed' | 'uploadSpeed'
): boolean {
  if (isMediaTask(task)) {
    return (
      field === 'downloadSpeed' &&
      task.status === TaskStatus.Downloading &&
      task.mediaProgress?.phase === 'downloading'
    )
  }
  const downloading =
    task.status === TaskStatus.Downloading ||
    task.status === TaskStatus.FetchingMetadata
  if (field === 'downloadSpeed') return downloading
  return (
    (task.type === TaskType.Bt || task.type === TaskType.Magnet) &&
    (downloading || task.status === TaskStatus.Seeding)
  )
}

export function getTaskSpeed(
  task: DownloadTask,
  field: 'downloadSpeed' | 'uploadSpeed'
): number | null {
  const speed = task[field]
  return isTaskSpeedApplicable(task, field) &&
    Number.isFinite(speed) &&
    speed >= 0
    ? speed
    : null
}

export function isTaskEtaApplicable(task: DownloadTask): boolean {
  return task.status === TaskStatus.Downloading && !isMediaProcessing(task)
}

export function getTaskEta(task: DownloadTask): number | null {
  if (!isTaskEtaApplicable(task)) return null
  return getTransferMetrics(task).etaSec
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
