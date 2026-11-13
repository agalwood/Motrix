import type { DownloadTask } from '@shared/types/task'

type MetadataObservation = Pick<
  DownloadTask,
  'engineTaskId' | 'status' | 'type'
>
export interface PendingMagnetMetadataObserver {
  observe(task: MetadataObservation): boolean
}
export function shouldSkipForPendingMagnetMetadata(
  task: MetadataObservation,
  tracker: PendingMagnetMetadataObserver | null
): boolean {
  return tracker?.observe(task) === true
}
