import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'

export function canRevealTaskFolder(task: DownloadTask): boolean {
  if (task.status === TaskStatus.FetchingMetadata) return false

  const diskPath = task.diskPath.trim()
  if (diskPath === '') return false

  return !isRootPath(diskPath)
}

function isRootPath(diskPath: string): boolean {
  const normalized = diskPath.replace(/[\\/]+$/, '')
  if (normalized === '') return true
  return /^[A-Za-z]:$/.test(normalized)
}
