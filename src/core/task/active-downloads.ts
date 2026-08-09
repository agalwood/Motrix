import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'

// "Active" = an in-flight download whose progress quitting would interrupt.
// Deliberately narrower than the renderer's UI "active" filters: Seeding is
// excluded (the file is already on disk), as are Queued/Paused/MetadataReady
// (nothing in flight) and the terminal states.
const ACTIVE_DOWNLOAD_STATUSES = new Set<TaskStatus>([
  TaskStatus.FetchingMetadata,
  TaskStatus.Downloading,
  TaskStatus.Finalizing,
])

export function isActiveDownload(task: DownloadTask): boolean {
  return ACTIVE_DOWNLOAD_STATUSES.has(task.status)
}

export function countActiveDownloads(tasks: DownloadTask[]): number {
  return tasks.filter(isActiveDownload).length
}
