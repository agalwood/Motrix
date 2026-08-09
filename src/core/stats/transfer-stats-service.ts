import type {
  GetTransferStatsParams,
  GlobalStats,
  TransferStatsSnapshot,
} from '@shared/types/stats'
import {
  TRANSFER_BUCKET_MS,
  TRANSFER_RETENTION_MS,
  type TransferDelta,
  type TransferStatsStore,
} from './transfer-stats-store'

export const TRANSFER_CHECKPOINT_MS = 30_000
export const TRANSFER_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000
export const MAX_TRANSFER_SAMPLE_GAP_SECONDS = 5
export const MAX_WALL_MONOTONIC_DRIFT_MS = 1_000

const MIN_QUERY_RANGE_MS = 22 * 60 * 60 * 1000
const MAX_QUERY_RANGE_MS = 26 * 60 * 60 * 1000

export type TransferCheckpointState =
  | 'idle'
  | 'scheduled'
  | 'flushing'
  | 'retryScheduled'

export interface TransferStatsServiceOptions {
  wallNow?: () => number
  monotonicNow?: () => number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
  onError?: (error: unknown) => void
}

interface TransferSample {
  wallMs: number
  monotonicMs: number
  downloadSpeed: number
  uploadSpeed: number
}

interface BucketSlice {
  bucketStartMs: number
  ratio: number
}

interface WholeByteSlice {
  bucketStartMs: number
  downloadBytes: bigint
  uploadBytes: bigint
}

function defaultMonotonicNow(): number {
  return performance.now()
}

function defaultSetTimer(
  callback: () => void,
  delayMs: number
): ReturnType<typeof setTimeout> {
  return setTimeout(callback, delayMs)
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>)
}

function isValidSpeed(speed: number): boolean {
  return Number.isFinite(speed) && speed >= 0
}

function isValidWallTime(value: number): boolean {
  return Number.isSafeInteger(value)
}

function isValidMonotonicTime(value: number): boolean {
  return Number.isFinite(value)
}

function floorToBucket(timestamp: number): number {
  return Math.floor(timestamp / TRANSFER_BUCKET_MS) * TRANSFER_BUCKET_MS
}

function addDelta(
  target: Map<number, TransferDelta>,
  bucketStartMs: number,
  downloadBytes: bigint,
  uploadBytes: bigint
): void {
  if (downloadBytes === 0n && uploadBytes === 0n) return

  const existing = target.get(bucketStartMs)
  if (existing) {
    existing.downloadBytes += downloadBytes
    existing.uploadBytes += uploadBytes
    return
  }

  target.set(bucketStartMs, { downloadBytes, uploadBytes })
}

function serializeRange(
  downloadBytes: bigint,
  uploadBytes: bigint,
  startedAt: number,
  coverageStartedAt: number,
  endsAt?: number
) {
  return {
    downloadBytes: downloadBytes.toString(),
    uploadBytes: uploadBytes.toString(),
    totalBytes: (downloadBytes + uploadBytes).toString(),
    startedAt,
    ...(endsAt === undefined ? {} : { endsAt }),
    coverageStartedAt,
  }
}

/**
 * Integrates aria2 global speed samples into durable process-wide transfer
 * totals. Sampling stays in memory; SQLite work is coalesced by a bounded
 * checkpoint timer.
 */
export class TransferStatsService {
  private readonly wallNow: () => number
  private readonly monotonicNow: () => number
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly onError: (error: unknown) => void
  private previousSample: TransferSample | null = null
  private readonly pending = new Map<number, TransferDelta>()
  private downloadRemainder = 0
  private uploadRemainder = 0
  private timerHandle: unknown | null = null
  private checkpointState: TransferCheckpointState = 'idle'
  private latestValidSampleAt: number | null = null
  private lastPruneAttemptMonotonicMs: number | null = null
  private disposed = false

  constructor(
    private readonly store: TransferStatsStore,
    options: TransferStatsServiceOptions = {}
  ) {
    this.wallNow = options.wallNow ?? Date.now
    this.monotonicNow = options.monotonicNow ?? defaultMonotonicNow
    this.setTimer = options.setTimer ?? defaultSetTimer
    this.clearTimer = options.clearTimer ?? defaultClearTimer
    this.onError = options.onError ?? (() => {})

    this.maybePrune(this.wallNow(), this.monotonicNow(), true)
  }

  record(stats: GlobalStats): void {
    if (this.disposed) return

    try {
      this.recordInternal(stats)
    } catch (error) {
      this.previousSample = null
      this.reportError(error)
    }
  }

  markGap(options: { flush?: boolean } = {}): boolean {
    try {
      if (options.flush === true && !this.disposed) {
        return this.flushNow(true)
      }
      return true
    } finally {
      this.previousSample = null
    }
  }

  snapshot(params: GetTransferStatsParams): TransferStatsSnapshot {
    this.validateQueryRange(params)

    const totals = this.store.readTotals()
    const buckets = this.store.readBuckets(params.dayStartMs, params.dayEndMs)
    let todayDownloadBytes = 0n
    let todayUploadBytes = 0n

    for (const bucket of buckets) {
      todayDownloadBytes += bucket.downloadBytes
      todayUploadBytes += bucket.uploadBytes
    }

    let pendingDownloadBytes = 0n
    let pendingUploadBytes = 0n
    for (const [bucketStartMs, delta] of this.pending) {
      pendingDownloadBytes += delta.downloadBytes
      pendingUploadBytes += delta.uploadBytes
      if (
        bucketStartMs >= params.dayStartMs &&
        bucketStartMs < params.dayEndMs
      ) {
        todayDownloadBytes += delta.downloadBytes
        todayUploadBytes += delta.uploadBytes
      }
    }

    const updatedAt =
      totals.updatedAt === null
        ? this.latestValidSampleAt
        : this.latestValidSampleAt === null
          ? totals.updatedAt
          : Math.max(totals.updatedAt, this.latestValidSampleAt)

    return {
      today: {
        ...serializeRange(
          todayDownloadBytes,
          todayUploadBytes,
          params.dayStartMs,
          Math.max(params.dayStartMs, totals.trackingStartedAt)
        ),
        endsAt: params.dayEndMs,
      },
      allTime: serializeRange(
        totals.downloadBytes + pendingDownloadBytes,
        totals.uploadBytes + pendingUploadBytes,
        totals.trackingStartedAt,
        totals.trackingStartedAt
      ),
      updatedAt,
      accuracy: 'estimated',
    }
  }

  dispose(): boolean {
    if (this.disposed) return this.pending.size === 0

    this.cancelTimer()
    let flushed = false
    try {
      flushed = this.flushPending(false)
      return flushed
    } finally {
      this.disposed = true
      this.previousSample = null
      this.cancelTimer()
    }
  }

  private recordInternal(stats: GlobalStats): void {
    const sample: TransferSample = {
      wallMs: this.wallNow(),
      monotonicMs: this.monotonicNow(),
      downloadSpeed: stats.totalDownloadSpeed,
      uploadSpeed: stats.totalUploadSpeed,
    }

    if (
      !isValidWallTime(sample.wallMs) ||
      !isValidMonotonicTime(sample.monotonicMs) ||
      !isValidSpeed(sample.downloadSpeed) ||
      !isValidSpeed(sample.uploadSpeed)
    ) {
      this.previousSample = null
      return
    }

    const previous = this.previousSample
    this.previousSample = sample
    if (!previous) {
      this.latestValidSampleAt = sample.wallMs
      return
    }

    const monotonicDeltaMs = sample.monotonicMs - previous.monotonicMs
    const wallDeltaMs = sample.wallMs - previous.wallMs
    if (
      monotonicDeltaMs <= 0 ||
      wallDeltaMs <= 0 ||
      Math.abs(wallDeltaMs - monotonicDeltaMs) > MAX_WALL_MONOTONIC_DRIFT_MS
    ) {
      return
    }

    this.latestValidSampleAt = sample.wallMs
    this.maybePrune(sample.wallMs, sample.monotonicMs)

    if (monotonicDeltaMs > MAX_TRANSFER_SAMPLE_GAP_SECONDS * 1_000) {
      return
    }

    const elapsedSeconds = monotonicDeltaMs / 1_000
    const downloadDelta =
      ((previous.downloadSpeed + sample.downloadSpeed) / 2) * elapsedSeconds
    const uploadDelta =
      ((previous.uploadSpeed + sample.uploadSpeed) / 2) * elapsedSeconds
    if (!Number.isFinite(downloadDelta) || !Number.isFinite(uploadDelta)) {
      throw new RangeError('Transfer sample delta exceeds the finite range')
    }

    const slices = this.buildSlices(previous.wallMs, sample.wallMs, wallDeltaMs)
    const wholeSlices = this.allocateWholeBytes(
      slices,
      downloadDelta,
      uploadDelta
    )

    for (const slice of wholeSlices) {
      addDelta(
        this.pending,
        slice.bucketStartMs,
        slice.downloadBytes,
        slice.uploadBytes
      )
    }

    if (this.pending.size > 0) {
      this.scheduleCheckpoint(false)
    }
  }

  private buildSlices(
    startWallMs: number,
    endWallMs: number,
    wallDeltaMs: number
  ): BucketSlice[] {
    const firstBucketStart = floorToBucket(startWallMs)
    const boundary = firstBucketStart + TRANSFER_BUCKET_MS
    if (boundary >= endWallMs) {
      return [{ bucketStartMs: firstBucketStart, ratio: 1 }]
    }

    return [
      {
        bucketStartMs: firstBucketStart,
        ratio: (boundary - startWallMs) / wallDeltaMs,
      },
      {
        bucketStartMs: boundary,
        ratio: (endWallMs - boundary) / wallDeltaMs,
      },
    ]
  }

  private allocateWholeBytes(
    slices: readonly BucketSlice[],
    downloadDelta: number,
    uploadDelta: number
  ): WholeByteSlice[] {
    let downloadRemainder = this.downloadRemainder
    let uploadRemainder = this.uploadRemainder
    const result: WholeByteSlice[] = []

    for (const slice of slices) {
      const downloadWithCarry = downloadRemainder + downloadDelta * slice.ratio
      const uploadWithCarry = uploadRemainder + uploadDelta * slice.ratio
      if (
        !Number.isFinite(downloadWithCarry) ||
        !Number.isFinite(uploadWithCarry)
      ) {
        throw new RangeError('Transfer slice exceeds the finite range')
      }

      const wholeDownload = Math.floor(downloadWithCarry)
      const wholeUpload = Math.floor(uploadWithCarry)
      downloadRemainder = downloadWithCarry - wholeDownload
      uploadRemainder = uploadWithCarry - wholeUpload
      result.push({
        bucketStartMs: slice.bucketStartMs,
        downloadBytes: BigInt(wholeDownload),
        uploadBytes: BigInt(wholeUpload),
      })
    }

    this.downloadRemainder = downloadRemainder
    this.uploadRemainder = uploadRemainder
    return result
  }

  private scheduleCheckpoint(retry: boolean): void {
    if (this.disposed || this.pending.size === 0 || this.timerHandle !== null) {
      return
    }

    try {
      this.timerHandle = this.setTimer(() => {
        this.timerHandle = null
        if (this.disposed) {
          this.checkpointState = 'idle'
          return
        }
        this.flushPending(true)
      }, TRANSFER_CHECKPOINT_MS)
      this.checkpointState = retry ? 'retryScheduled' : 'scheduled'
    } catch (error) {
      this.checkpointState = 'idle'
      this.reportError(error)
    }
  }

  private flushNow(retryOnFailure: boolean): boolean {
    this.cancelTimer()
    return this.flushPending(retryOnFailure)
  }

  private flushPending(retryOnFailure: boolean): boolean {
    if (this.pending.size === 0) {
      this.checkpointState = 'idle'
      return true
    }

    this.checkpointState = 'flushing'
    const checkpoint = new Map<number, TransferDelta>()
    for (const [bucketStartMs, delta] of this.pending) {
      checkpoint.set(bucketStartMs, { ...delta })
    }

    try {
      const updatedAt = this.latestValidSampleAt ?? this.wallNow()
      this.store.checkpoint(checkpoint, updatedAt)
      for (const [bucketStartMs, committed] of checkpoint) {
        const current = this.pending.get(bucketStartMs)
        if (!current) continue

        current.downloadBytes -= committed.downloadBytes
        current.uploadBytes -= committed.uploadBytes
        if (current.downloadBytes === 0n && current.uploadBytes === 0n) {
          this.pending.delete(bucketStartMs)
        }
      }
      this.checkpointState = 'idle'
      if (this.pending.size > 0) this.scheduleCheckpoint(false)
      return true
    } catch (error) {
      this.checkpointState = 'idle'
      this.reportError(error)
      if (retryOnFailure) this.scheduleCheckpoint(true)
      return false
    }
  }

  private cancelTimer(): void {
    if (this.timerHandle !== null) {
      const handle = this.timerHandle
      this.timerHandle = null
      try {
        this.clearTimer(handle)
      } catch (error) {
        this.reportError(error)
      }
    }
    if (this.checkpointState !== 'flushing') {
      this.checkpointState = 'idle'
    }
  }

  private maybePrune(wallMs: number, monotonicMs: number, force = false): void {
    if (!isValidWallTime(wallMs) || !isValidMonotonicTime(monotonicMs)) {
      return
    }
    if (
      !force &&
      this.lastPruneAttemptMonotonicMs !== null &&
      monotonicMs - this.lastPruneAttemptMonotonicMs <
        TRANSFER_PRUNE_INTERVAL_MS
    ) {
      return
    }

    this.lastPruneAttemptMonotonicMs = monotonicMs
    const cutoff = floorToBucket(wallMs - TRANSFER_RETENTION_MS)
    try {
      this.store.pruneBefore(cutoff)
    } catch (error) {
      this.reportError(error)
    }
  }

  private validateQueryRange(params: GetTransferStatsParams): void {
    const { dayStartMs, dayEndMs } = params
    if (!Number.isSafeInteger(dayStartMs) || !Number.isSafeInteger(dayEndMs)) {
      throw new RangeError('Transfer query bounds must be safe integers')
    }
    if (dayEndMs <= dayStartMs) {
      throw new RangeError('dayEndMs must be greater than dayStartMs')
    }
    if (
      dayStartMs % TRANSFER_BUCKET_MS !== 0 ||
      dayEndMs % TRANSFER_BUCKET_MS !== 0
    ) {
      throw new RangeError(
        `Transfer query bounds must align to ${TRANSFER_BUCKET_MS} milliseconds`
      )
    }

    const duration = dayEndMs - dayStartMs
    if (duration < MIN_QUERY_RANGE_MS || duration > MAX_QUERY_RANGE_MS) {
      throw new RangeError(
        'Transfer query range must be between 22 and 26 hours'
      )
    }
  }

  private reportError(error: unknown): void {
    try {
      this.onError(error)
    } catch {
      // Error reporting must not destabilize polling or lifecycle callbacks.
    }
  }
}
