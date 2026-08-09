import type { DownloadProgress } from '@shared/types/geoip'

export type { DownloadProgress }

export interface DownloadResult {
  /** Bytes written to disk after a successful download. */
  sizeBytes: number
  /**
   * Free-form version tag derived from response headers. Falls back to
   * an ISO timestamp when neither ETag nor Content-Disposition is set.
   */
  version: string
}

export interface DownloadOptions {
  /** Hard timeout for the entire download in milliseconds. */
  timeoutMs: number
  /** Minimum bytes between two progress emissions. */
  progressByteThreshold: number
  /** Minimum ms between two progress emissions. */
  progressTimeThresholdMs: number
}

export const DEFAULT_DOWNLOAD_OPTIONS: DownloadOptions = {
  timeoutMs: 60_000,
  progressByteThreshold: 64 * 1024,
  progressTimeThresholdMs: 250,
}
