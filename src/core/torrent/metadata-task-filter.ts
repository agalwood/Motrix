import type { Aria2RawStatus } from '@core/engine/aria2/types'

export interface PendingMagnetMetadataObserver {
  observe(raw: Aria2RawStatus): boolean
}

export function shouldSkipForPendingMagnetMetadata(
  raw: Aria2RawStatus,
  tracker: PendingMagnetMetadataObserver | null
): boolean {
  return tracker?.observe(raw) === true
}
