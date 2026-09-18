import type { SegmentFileProgress } from '@core/download/segment-downloader'
import type { SegmentPlan } from '@core/media/segment-plan'
import {
  type DownloadTask,
  type TaskFile,
  TaskInstancePhase,
} from '@shared/types/task'
import { z } from 'zod'

// Display metadata only; source manifests live in the central media store.
export const mediaFileSchema = z.object({
  path: z.string(),
  size: z.number().finite().nonnegative(),
  completedBytes: z.number().finite().nonnegative(),
  progress: z.number().min(0).max(1),
})
export type MediaFile = z.infer<typeof mediaFileSchema>

export function createMediaTaskFiles(
  plan: SegmentPlan,
  stream: 'video' | 'audio'
): MediaFile[] {
  const parts = plan.init ? [plan.init, ...plan.segments] : plan.segments
  return parts.map((part, index) => {
    const name = new URL(part.url).pathname.split('/').at(-1) || 'segment'
    const order =
      plan.init && index === 0
        ? 'init'
        : String(index + (plan.init ? 0 : 1)).padStart(6, '0')
    return {
      path: `${stream}/${order}-${name}`,
      size: part.byteRange?.length ?? 0,
      completedBytes: 0,
      progress: 0,
    }
  })
}

export function updateMediaTaskFile(
  files: MediaFile[],
  update: SegmentFileProgress
): void {
  const file = files[update.index]
  if (!file) return
  const size = update.totalBytes || file.size
  files[update.index] = {
    ...file,
    size,
    completedBytes: update.completed ? size : update.downloadedBytes,
    progress: update.completed
      ? 1
      : size > 0
        ? Math.min(update.downloadedBytes / size, 1)
        : 0,
  } satisfies MediaFile
}

export function toMediaTaskFiles(files: MediaFile[]): TaskFile[] {
  return files.map((file, index) => ({ ...file, index, selected: true }))
}

export function getMediaMetaPath(task: DownloadTask): string | undefined {
  const value = task.instances?.find(
    (instance) => instance.phase === TaskInstancePhase.HlsSegment
  )?.payload.mediaMetaPath
  return typeof value === 'string' ? value : undefined
}
