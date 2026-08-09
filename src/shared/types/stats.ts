export interface GlobalStats {
  totalDownloadSpeed: number
  totalUploadSpeed: number
  activeTasks: number
  waitingTasks: number
  stoppedTasks: number
}

export interface SpeedPoint {
  /** Unix milliseconds. */
  t: number
  /** Bytes per second downloaded at sample time. */
  down: number
  /** Bytes per second uploaded at sample time. */
  up: number
}

/** JSON-safe decimal representation of a non-negative byte count. */
export type SerializedByteCount = string

export interface TransferRangeStats {
  downloadBytes: SerializedByteCount
  uploadBytes: SerializedByteCount
  totalBytes: SerializedByteCount
  startedAt: number
  endsAt?: number
  coverageStartedAt: number
}

export interface TransferStatsSnapshot {
  today: TransferRangeStats & { endsAt: number }
  allTime: TransferRangeStats
  updatedAt: number | null
  accuracy: 'estimated'
}

export interface GetTransferStatsParams {
  dayStartMs: number
  dayEndMs: number
}
