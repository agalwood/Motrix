import {
  MediaProgressSchema,
  type MediaProgressSnapshot,
} from '@shared/schemas/media-progress'
import {
  type DownloadTask,
  TaskInstancePhase,
  TaskStatus,
} from '@shared/types/task'
import { isMediaTask } from '@shared/utils/media-progress'

export function setMediaProgress(
  task: DownloadTask,
  snapshot: MediaProgressSnapshot
): void {
  task.mediaProgress = snapshot
  task.progress = snapshot.download.progress
  task.totalBytes = snapshot.download.totalBytes ?? 0
  task.sizeWhenDone = snapshot.outputBytes ?? 0
  const instance = task.instances.find(
    (i) => i.phase === TaskInstancePhase.HlsSegment
  )
  if (instance)
    instance.payload = { ...instance.payload, mediaProgress: snapshot }
}

/** Restore only the bounded summary, without reading every segment file. */
export function restoreMediaProgress(task: DownloadTask): DownloadTask {
  if (!isMediaTask(task)) return task
  const payload = task.instances.find(
    (i) => i.phase === TaskInstancePhase.HlsSegment
  )?.payload.mediaProgress
  const parsed = MediaProgressSchema.safeParse(payload)
  if (parsed.success) {
    setMediaProgress(task, parsed.data)
  } else {
    task.mediaProgress = undefined
    task.progress = 0
    task.totalBytes = 0
    task.sizeWhenDone = 0
  }
  if (task.status === TaskStatus.Completed) task.progress = 1
  return task
}
