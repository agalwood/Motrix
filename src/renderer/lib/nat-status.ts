import { NatState, type NatStatus } from '@shared/types/nat'

// Shared NAT status semantics for the renderer. Both NatBadge (downloads
// stats bar) and NatTile (dashboard) classify a NatStatus the same way; only
// the i18n namespace they map the bucket to differs.

export type NatBucket = 'active' | 'settingUp' | 'failed' | 'off'

export interface NatBucketDescriptor {
  bucket: NatBucket
  /** Tailwind background class for the status dot. */
  color: string
}

/**
 * Classify a NatStatus into a coarse display bucket + dot color.
 *
 * Failed-with-retry-budget is deliberately reported as `settingUp` so the UI
 * does not flicker red↔blue between scheduled retry attempts; the retry
 * counter is surfaced separately via {@link isNatRetrying}.
 */
export function natBucket(status: NatStatus | null): NatBucketDescriptor {
  if (!status) {
    return { bucket: 'off', color: 'bg-gray-500' }
  }
  switch (status.state) {
    case NatState.Active:
      return { bucket: 'active', color: 'bg-green-500' }
    case NatState.Discovering:
    case NatState.Mapping:
    case NatState.Ready:
      return { bucket: 'settingUp', color: 'bg-blue-500' }
    case NatState.Failed:
      return status.retryAttempt < status.maxRetries
        ? { bucket: 'settingUp', color: 'bg-blue-500' }
        : { bucket: 'failed', color: 'bg-red-500' }
    default:
      return { bucket: 'off', color: 'bg-gray-500' }
  }
}

/** True while the manager has a retry queued (and is not dormant-failed). */
export function isNatRetrying(status: NatStatus | null): boolean {
  if (!status) return false
  if (status.retryAttempt <= 0) return false
  return !(
    status.state === NatState.Failed && status.retryAttempt >= status.maxRetries
  )
}

/**
 * True when NAT is doing work (or still retrying). Dormant Failed (budget
 * exhausted) and the stopped/idle states count as not running — those are the
 * states from which "Enable" starts a fresh attempt.
 */
export function isNatRunning(status: NatStatus | null): boolean {
  if (!status) return false
  switch (status.state) {
    case NatState.Active:
    case NatState.Discovering:
    case NatState.Mapping:
    case NatState.Ready:
      return true
    case NatState.Failed:
      return status.retryAttempt < status.maxRetries
    default:
      return false
  }
}
