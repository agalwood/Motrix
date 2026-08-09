import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { v1 } from '../session/migrations/v1'
import {
  TRANSFER_BUCKET_MS,
  type TransferDelta,
  TransferStatsStore,
} from './transfer-stats-store'

const openedDatabases: Database.Database[] = []
const temporaryDirectories: string[] = []

function openDatabase(path = ':memory:'): Database.Database {
  const db = new Database(path)
  db.pragma('foreign_keys = ON')
  openedDatabases.push(db)
  return db
}

function freshDatabase(path = ':memory:'): Database.Database {
  const db = openDatabase(path)
  db.transaction(() => v1.up(db))()
  return db
}

function delta(downloadBytes: bigint, uploadBytes: bigint): TransferDelta {
  return { downloadBytes, uploadBytes }
}

afterEach(() => {
  for (const db of openedDatabases.splice(0)) {
    if (db.open) db.close()
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('TransferStatsStore', () => {
  it('initializes its singleton once and preserves the first tracking time', () => {
    const db = freshDatabase()

    const first = new TransferStatsStore(db, 1_000)
    const second = new TransferStatsStore(db, 2_000)

    expect(first.readTotals()).toEqual({
      downloadBytes: 0n,
      uploadBytes: 0n,
      trackingStartedAt: 1_000,
      updatedAt: null,
    })
    expect(second.readTotals()).toEqual(first.readTotals())
    expect(
      (
        db.prepare('SELECT COUNT(*) AS count FROM transfer_totals').get() as {
          count: number
        }
      ).count
    ).toBe(1)
  })

  it('atomically increments totals and one or more buckets', () => {
    const db = freshDatabase()
    const store = new TransferStatsStore(db, 100)
    const firstBucket = 0
    const secondBucket = TRANSFER_BUCKET_MS

    store.checkpoint(
      new Map([
        [firstBucket, delta(10n, 3n)],
        [secondBucket, delta(20n, 4n)],
      ]),
      1_000
    )
    store.checkpoint(new Map([[firstBucket, delta(2n, 1n)]]), 2_000)

    expect(store.readTotals()).toEqual({
      downloadBytes: 32n,
      uploadBytes: 8n,
      trackingStartedAt: 100,
      updatedAt: 2_000,
    })
    expect(store.readBuckets(0, TRANSFER_BUCKET_MS * 2)).toEqual([
      {
        bucketStartMs: firstBucket,
        downloadBytes: 12n,
        uploadBytes: 4n,
        updatedAt: 2_000,
      },
      {
        bucketStartMs: secondBucket,
        downloadBytes: 20n,
        uploadBytes: 4n,
        updatedAt: 1_000,
      },
    ])
  })

  it('does no writes for empty or all-zero checkpoints', () => {
    const db = freshDatabase()
    const store = new TransferStatsStore(db, 100)

    store.checkpoint(new Map(), 1_000)
    store.checkpoint(new Map([[0, delta(0n, 0n)]]), 2_000)

    expect(store.readTotals().updatedAt).toBeNull()
    expect(store.readBuckets(0, TRANSFER_BUCKET_MS)).toEqual([])
  })

  it('restores exact values after reopening the database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'motrix-transfer-store-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'stats.sqlite')
    const firstDb = freshDatabase(path)
    const firstStore = new TransferStatsStore(firstDb, 100)
    firstStore.checkpoint(new Map([[0, delta(123n, 45n)]]), 1_000)
    firstDb.close()

    const reopenedDb = openDatabase(path)
    const reopenedStore = new TransferStatsStore(reopenedDb, 2_000)

    expect(reopenedStore.readTotals()).toEqual({
      downloadBytes: 123n,
      uploadBytes: 45n,
      trackingStartedAt: 100,
      updatedAt: 1_000,
    })
    expect(reopenedStore.readBuckets(0, TRANSFER_BUCKET_MS)).toHaveLength(1)
  })

  it('rolls back totals when a bucket upsert fails', () => {
    const db = freshDatabase()
    const store = new TransferStatsStore(db, 100)
    db.exec(`
      CREATE TRIGGER fail_transfer_bucket
      BEFORE INSERT ON transfer_buckets
      BEGIN
        SELECT RAISE(ABORT, 'injected bucket failure');
      END;
    `)

    expect(() =>
      store.checkpoint(new Map([[0, delta(10n, 2n)]]), 1_000)
    ).toThrow(/injected bucket failure/)

    expect(store.readTotals()).toEqual({
      downloadBytes: 0n,
      uploadBytes: 0n,
      trackingStartedAt: 100,
      updatedAt: null,
    })
    expect(store.readBuckets(0, TRANSFER_BUCKET_MS)).toEqual([])
  })

  it('prunes old buckets without changing all-time totals', () => {
    const db = freshDatabase()
    const store = new TransferStatsStore(db, 100)
    store.checkpoint(
      new Map([
        [0, delta(5n, 1n)],
        [TRANSFER_BUCKET_MS, delta(7n, 2n)],
      ]),
      1_000
    )

    expect(store.pruneBefore(TRANSFER_BUCKET_MS)).toBe(1)
    expect(store.readBuckets(0, TRANSFER_BUCKET_MS * 2)).toEqual([
      {
        bucketStartMs: TRANSFER_BUCKET_MS,
        downloadBytes: 7n,
        uploadBytes: 2n,
        updatedAt: 1_000,
      },
    ])
    expect(store.readTotals()).toMatchObject({
      downloadBytes: 12n,
      uploadBytes: 3n,
    })
  })

  it('round-trips values on both sides of 2^53 as bigint', () => {
    const db = freshDatabase()
    const store = new TransferStatsStore(db, 100)
    const below = (1n << 53n) - 1n
    const above = (1n << 53n) + 1n

    store.checkpoint(new Map([[0, delta(below, above)]]), 1_000)

    expect(store.readTotals()).toMatchObject({
      downloadBytes: below,
      uploadBytes: above,
    })
    expect(store.readBuckets(0, TRANSFER_BUCKET_MS)[0]).toMatchObject({
      downloadBytes: below,
      uploadBytes: above,
    })
  })

  it('fails signed-int64 overflow without partially inserting a bucket', () => {
    const db = freshDatabase()
    const store = new TransferStatsStore(db, 100)
    const maxInt64 = 9_223_372_036_854_775_807n
    db.prepare(
      `UPDATE transfer_totals
       SET download_bytes = ?
       WHERE id = 1`
    ).run(maxInt64)

    expect(() =>
      store.checkpoint(new Map([[0, delta(1n, 0n)]]), 1_000)
    ).toThrow(/CHECK/i)

    expect(store.readTotals().downloadBytes).toBe(maxInt64)
    expect(store.readBuckets(0, TRANSFER_BUCKET_MS)).toEqual([])
  })

  it('keeps transfer totals after task deletion', () => {
    const db = freshDatabase()
    const store = new TransferStatsStore(db, 100)
    db.prepare(
      `INSERT INTO tasks (
        motrix_id, name, kind, task_type, priority, created_at, updated_at,
        final_path, final_name, total_bytes, downloaded_bytes,
        size_when_done, file_count, is_private, trackers, piece_length,
        agg_status, uploaded_bytes_baseline, source
      ) VALUES (
        'task-1', 'file', 'direct', 'http', 0, 1, 1,
        '', '', 0, 0,
        0, 0, 0, '[]', 0,
        'queued', 0, 'user'
      )`
    ).run()
    store.checkpoint(new Map([[0, delta(8n, 3n)]]), 1_000)

    db.prepare('DELETE FROM tasks WHERE motrix_id = ?').run('task-1')

    expect(store.readTotals()).toMatchObject({
      downloadBytes: 8n,
      uploadBytes: 3n,
    })
    expect(store.readBuckets(0, TRANSFER_BUCKET_MS)).toHaveLength(1)
  })
})
