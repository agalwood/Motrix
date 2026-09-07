import type { DownloadTask, TaskInstance } from '@shared/types/task'
import { pickPrimaryInstance } from './task-instance'

const KEY = 'btFinalizeUpload'

function accountedUpload(
  instances: readonly TaskInstance[],
  gid: string
): number | null {
  for (const instance of instances) {
    const value = instance.payload[KEY] as
      | { gid?: unknown; bytes?: unknown }
      | undefined
    if (
      value?.gid === gid &&
      typeof value.bytes === 'number' &&
      Number.isFinite(value.bytes) &&
      value.bytes >= 0
    )
      return value.bytes
  }
  return null
}

/** Only the unaccounted part of the current GID belongs above the baseline. */
export function unsettledBtUpload(
  instances: readonly TaskInstance[],
  gid: string,
  uploadedBytes: number
): number {
  return Math.max(0, uploadedBytes - (accountedUpload(instances, gid) ?? 0))
}

/** Persist this marker together with the task baseline before retiring its GID. */
export function settleBtUpload(
  task: DownloadTask,
  upload: number,
  recovering: boolean
): void {
  const primary = pickPrimaryInstance(task.instances)
  const accounted = accountedUpload(task.instances, task.engineTaskId)
  // Old interrupted finalizes already saved their baseline without a marker.
  // Preserve that total instead of guessing and crediting the same GID twice.
  const previous = accounted ?? (recovering && primary ? upload : 0)
  task.uploadedBytesBaseline += Math.max(0, upload - previous)
  task.uploadedBytes = task.uploadedBytesBaseline
  if (primary) {
    primary.payload = {
      ...primary.payload,
      [KEY]: { gid: task.engineTaskId, bytes: Math.max(previous, upload) },
    }
  }
}
