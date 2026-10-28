import type { Aria2TaskStatus } from '@core/engine/aria2/types'

export interface PendingMagnetMetadataObserver {
  observe(raw: Aria2TaskStatus): boolean
}

export function shouldSkipForPendingMagnetMetadata(
  raw: Aria2TaskStatus,
  tracker: PendingMagnetMetadataObserver | null
): boolean {
  return tracker?.observe(raw) === true
}
