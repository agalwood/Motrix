import type Database from 'better-sqlite3'
import {
  requireSafeTimestamp,
  safeIntegerFromSql,
} from '../lib/sqlite-integers'

export const TRANSFER_BUCKET_MS = 15 * 60 * 1000
export const TRANSFER_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

export interface TransferDelta {
  downloadBytes: bigint
  uploadBytes: bigint
}

export interface PersistedTransferTotals extends TransferDelta {
  trackingStartedAt: number
  updatedAt: number | null
}

export interface PersistedTransferBucket extends TransferDelta {
  bucketStartMs: number
  updatedAt: number
}

interface SafeIntegerTotalsRow {
  download_bytes: bigint
  upload_bytes: bigint
  tracking_started_at: bigint
  updated_at: bigint | null
}

interface SafeIntegerBucketRow {
  bucket_start_ms: bigint
  download_bytes: bigint
  upload_bytes: bigint
  updated_at: bigint
}

function requireDelta(delta: TransferDelta, bucketStartMs: number): void {
  if (
    typeof delta.downloadBytes !== 'bigint' ||
    typeof delta.uploadBytes !== 'bigint' ||
    delta.downloadBytes < 0n ||
    delta.uploadBytes < 0n
  ) {
    throw new RangeError(
      `Transfer delta for bucket ${bucketStartMs} must contain non-negative bigint values`
    )
  }
}

/**
 * SQLite persistence for process-wide transfer statistics.
 *
 * Byte reads intentionally opt into better-sqlite3 safe integers so values
 * never pass through JavaScript's lossy `number` representation.
 */
export class TransferStatsStore {
  constructor(
    private readonly db: Database.Database,
    now = Date.now()
  ) {
    requireSafeTimestamp(now, 'now')
    this.db
      .prepare(
        `INSERT OR IGNORE INTO transfer_totals (
          id,
          download_bytes,
          upload_bytes,
          tracking_started_at,
          updated_at
        ) VALUES (1, 0, 0, ?, NULL)`
      )
      .run(BigInt(now))
  }

  checkpoint(
    deltas: ReadonlyMap<number, TransferDelta>,
    updatedAt: number
  ): void {
    requireSafeTimestamp(updatedAt, 'updatedAt')

    const entries: Array<readonly [number, TransferDelta]> = []
    let totalDownloadBytes = 0n
    let totalUploadBytes = 0n

    for (const [bucketStartMs, delta] of deltas) {
      requireSafeTimestamp(bucketStartMs, 'bucketStartMs')
      if (bucketStartMs % TRANSFER_BUCKET_MS !== 0) {
        throw new RangeError(
          `bucketStartMs must align to ${TRANSFER_BUCKET_MS} milliseconds`
        )
      }
      requireDelta(delta, bucketStartMs)
      if (delta.downloadBytes === 0n && delta.uploadBytes === 0n) continue

      entries.push([bucketStartMs, delta])
      totalDownloadBytes += delta.downloadBytes
      totalUploadBytes += delta.uploadBytes
    }

    if (entries.length === 0) return

    entries.sort(([left], [right]) => left - right)

    this.db.transaction(() => {
      const totalUpdate = this.db
        .prepare(
          `UPDATE transfer_totals
           SET
             download_bytes = download_bytes + ?,
             upload_bytes = upload_bytes + ?,
             updated_at = ?
           WHERE id = 1`
        )
        .run(totalDownloadBytes, totalUploadBytes, BigInt(updatedAt))

      if (totalUpdate.changes !== 1) {
        throw new Error('Transfer totals singleton is missing')
      }

      const upsertBucket = this.db.prepare(
        `INSERT INTO transfer_buckets (
          bucket_start_ms,
          download_bytes,
          upload_bytes,
          updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(bucket_start_ms) DO UPDATE SET
          download_bytes =
            transfer_buckets.download_bytes + excluded.download_bytes,
          upload_bytes =
            transfer_buckets.upload_bytes + excluded.upload_bytes,
          updated_at = excluded.updated_at`
      )

      for (const [bucketStartMs, delta] of entries) {
        upsertBucket.run(
          BigInt(bucketStartMs),
          delta.downloadBytes,
          delta.uploadBytes,
          BigInt(updatedAt)
        )
      }
    })()
  }

  readTotals(): PersistedTransferTotals {
    const row = this.db
      .prepare(
        `SELECT
          download_bytes,
          upload_bytes,
          tracking_started_at,
          updated_at
        FROM transfer_totals
        WHERE id = 1`
      )
      .safeIntegers()
      .get() as SafeIntegerTotalsRow | undefined

    if (!row) {
      throw new Error('Transfer totals singleton is missing')
    }

    return {
      downloadBytes: row.download_bytes,
      uploadBytes: row.upload_bytes,
      trackingStartedAt: safeIntegerFromSql(
        row.tracking_started_at,
        'tracking_started_at'
      ),
      updatedAt:
        row.updated_at === null
          ? null
          : safeIntegerFromSql(row.updated_at, 'updated_at'),
    }
  }

  readBuckets(fromMs: number, toMs: number): PersistedTransferBucket[] {
    requireSafeTimestamp(fromMs, 'fromMs')
    requireSafeTimestamp(toMs, 'toMs')
    if (toMs <= fromMs) {
      throw new RangeError('toMs must be greater than fromMs')
    }

    const rows = this.db
      .prepare(
        `SELECT
          bucket_start_ms,
          download_bytes,
          upload_bytes,
          updated_at
        FROM transfer_buckets
        WHERE bucket_start_ms >= ? AND bucket_start_ms < ?
        ORDER BY bucket_start_ms`
      )
      .safeIntegers()
      .all(BigInt(fromMs), BigInt(toMs)) as SafeIntegerBucketRow[]

    return rows.map((row) => ({
      bucketStartMs: safeIntegerFromSql(row.bucket_start_ms, 'bucket_start_ms'),
      downloadBytes: row.download_bytes,
      uploadBytes: row.upload_bytes,
      updatedAt: safeIntegerFromSql(row.updated_at, 'updated_at'),
    }))
  }

  pruneBefore(cutoffMs: number): number {
    requireSafeTimestamp(cutoffMs, 'cutoffMs')
    return this.db
      .prepare('DELETE FROM transfer_buckets WHERE bucket_start_ms < ?')
      .run(BigInt(cutoffMs)).changes
  }
}
