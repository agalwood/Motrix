import type { GlobalStats } from '@shared/types/stats'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { v1 } from '../session/migrations/v1'
import {
  MAX_TRANSFER_SAMPLE_GAP_SECONDS,
  TRANSFER_CHECKPOINT_MS,
  TransferStatsService,
} from './transfer-stats-service'
import {
  TRANSFER_BUCKET_MS,
  TRANSFER_RETENTION_MS,
  TransferStatsStore,
} from './transfer-stats-store'

const DAY_MS = 24 * 60 * 60 * 1000
const BASE_DAY = DAY_MS * 20_000
const openedDatabases: Database.Database[] = []

class ManualClock {
  wallMs = BASE_DAY
  monotonicMs = 0
  private nextTimerId = 1
  private readonly timers = new Map<
    number,
    { callback: () => void; dueAt: number }
  >()

  wallNow = (): number => this.wallMs
  monotonicNow = (): number => this.monotonicMs

  setTimer = (callback: () => void, delayMs: number): unknown => {
    const id = this.nextTimerId
    this.nextTimerId += 1
    this.timers.set(id, {
      callback,
      dueAt: this.monotonicMs + delayMs,
    })
    return id
  }

  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number)
  }

  advance(ms: number): void {
    this.wallMs += ms
    this.monotonicMs += ms
    this.runDueTimers()
  }

  jumpWall(ms: number): void {
    this.wallMs += ms
  }

  advanceMonotonic(ms: number): void {
    this.monotonicMs += ms
    this.runDueTimers()
  }

  get timerCount(): number {
    return this.timers.size
  }

  private runDueTimers(): void {
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= this.monotonicMs)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0]
      if (!next) return

      const [id, timer] = next
      this.timers.delete(id)
      timer.callback()
    }
  }
}

function freshStore(clock: ManualClock): {
  db: Database.Database
  store: TransferStatsStore
} {
  const db = new Database(':memory:')
  openedDatabases.push(db)
  db.pragma('foreign_keys = ON')
  db.transaction(() => v1.up(db))()
  return {
    db,
    store: new TransferStatsStore(db, clock.wallMs),
  }
}

function createService(
  clock = new ManualClock(),
  onError: (error: unknown) => void = () => {}
) {
  const { db, store } = freshStore(clock)
  const service = new TransferStatsService(store, {
    wallNow: clock.wallNow,
    monotonicNow: clock.monotonicNow,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onError,
  })
  return { clock, db, store, service }
}

function stats(downloadSpeed: number, uploadSpeed: number): GlobalStats {
  return {
    totalDownloadSpeed: downloadSpeed,
    totalUploadSpeed: uploadSpeed,
    activeTasks: 0,
    waitingTasks: 0,
    stoppedTasks: 0,
  }
}

function currentDaySnapshot(service: TransferStatsService) {
  return service.snapshot({
    dayStartMs: BASE_DAY,
    dayEndMs: BASE_DAY + DAY_MS,
  })
}

afterEach(() => {
  for (const db of openedDatabases.splice(0)) {
    if (db.open) db.close()
  }
})

describe('TransferStatsService sampling', () => {
  it('uses the first sample only as a baseline', () => {
    const { service } = createService()

    service.record(stats(100, 50))

    expect(currentDaySnapshot(service)).toMatchObject({
      today: {
        downloadBytes: '0',
        uploadBytes: '0',
        totalBytes: '0',
      },
      allTime: {
        downloadBytes: '0',
        uploadBytes: '0',
      },
      updatedAt: BASE_DAY,
      accuracy: 'estimated',
    })
  })

  it('uses trapezoidal integration over a valid one-second interval', () => {
    const { clock, service } = createService()
    service.record(stats(100, 20))
    clock.advance(1_000)

    service.record(stats(300, 40))

    expect(currentDaySnapshot(service)).toMatchObject({
      today: {
        downloadBytes: '200',
        uploadBytes: '30',
        totalBytes: '230',
      },
      allTime: {
        downloadBytes: '200',
        uploadBytes: '30',
        totalBytes: '230',
      },
    })
  })

  it('does not schedule writes for zero-speed intervals', () => {
    const { clock, service, store } = createService()
    const checkpoint = vi.spyOn(store, 'checkpoint')
    service.record(stats(0, 0))
    clock.advance(1_000)

    service.record(stats(0, 0))

    expect(clock.timerCount).toBe(0)
    expect(checkpoint).not.toHaveBeenCalled()
    expect(currentDaySnapshot(service).today.totalBytes).toBe('0')
  })

  it.each([
    ['zero monotonic delta', 0],
    ['negative monotonic delta', -1],
    [
      'over-five-second monotonic delta',
      MAX_TRANSFER_SAMPLE_GAP_SECONDS * 1_000 + 1,
    ],
  ])('treats %s as a gap', (_name, monotonicDelta) => {
    const { clock, service } = createService()
    service.record(stats(100, 50))
    clock.jumpWall(Math.max(1, monotonicDelta))
    clock.advanceMonotonic(monotonicDelta)

    service.record(stats(100, 50))

    expect(currentDaySnapshot(service).today.totalBytes).toBe('0')
  })

  it.each([
    ['negative', -1],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('invalid %s speeds clear the baseline', (_name, invalidSpeed) => {
    const { clock, service } = createService()
    service.record(stats(100, 10))
    clock.advance(1_000)
    service.record(stats(invalidSpeed, 10))
    clock.advance(1_000)
    service.record(stats(100, 10))

    expect(currentDaySnapshot(service).today.totalBytes).toBe('0')
  })

  it('rejects forward and backward wall-clock divergence and re-anchors', () => {
    const { clock, service } = createService()
    service.record(stats(100, 0))
    clock.advanceMonotonic(1_000)
    clock.jumpWall(5_000)
    service.record(stats(100, 0))
    clock.advanceMonotonic(1_000)
    clock.jumpWall(-2_000)
    service.record(stats(100, 0))

    expect(currentDaySnapshot(service).today.downloadBytes).toBe('0')
  })

  it('splits a boundary interval and conserves its whole bytes', () => {
    const clock = new ManualClock()
    clock.wallMs = BASE_DAY + TRANSFER_BUCKET_MS - 500
    const { service, store } = createService(clock)
    service.record(stats(100, 20))
    clock.advance(1_000)

    service.record(stats(100, 20))

    expect(currentDaySnapshot(service).today).toMatchObject({
      downloadBytes: '100',
      uploadBytes: '20',
    })
    service.markGap({ flush: true })
    expect(
      store.readBuckets(BASE_DAY, BASE_DAY + TRANSFER_BUCKET_MS * 2)
    ).toEqual([
      {
        bucketStartMs: BASE_DAY,
        downloadBytes: 50n,
        uploadBytes: 10n,
        updatedAt: BASE_DAY + TRANSFER_BUCKET_MS + 500,
      },
      {
        bucketStartMs: BASE_DAY + TRANSFER_BUCKET_MS,
        downloadBytes: 50n,
        uploadBytes: 10n,
        updatedAt: BASE_DAY + TRANSFER_BUCKET_MS + 500,
      },
    ])
  })

  it('carries fractional bytes globally across buckets and checkpoints', () => {
    const clock = new ManualClock()
    clock.wallMs = BASE_DAY + TRANSFER_BUCKET_MS - 1_000
    const { service, store } = createService(clock)
    service.record(stats(0.75, 0))
    clock.advance(1_000)
    service.record(stats(0.75, 0))
    clock.advance(1_000)
    service.record(stats(0.75, 0))

    expect(currentDaySnapshot(service).today.downloadBytes).toBe('1')
    expect(service.markGap({ flush: true })).toBe(true)
    expect(store.readTotals().downloadBytes).toBe(1n)

    service.record(stats(0.75, 0))
    clock.advance(1_000)
    service.record(stats(0.75, 0))

    expect(currentDaySnapshot(service).allTime.downloadBytes).toBe('2')
  })
})

describe('TransferStatsService checkpoint lifecycle', () => {
  it('coalesces dirty samples behind one 30-second timer', () => {
    const { clock, service, store } = createService()
    const checkpoint = vi.spyOn(store, 'checkpoint')
    service.record(stats(10, 0))
    clock.advance(1_000)
    service.record(stats(10, 0))
    clock.advance(1_000)
    service.record(stats(10, 0))

    expect(clock.timerCount).toBe(1)
    expect(checkpoint).not.toHaveBeenCalled()
    expect(currentDaySnapshot(service).today.downloadBytes).toBe('20')

    clock.advance(TRANSFER_CHECKPOINT_MS)

    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(clock.timerCount).toBe(0)
    expect(store.readTotals().downloadBytes).toBe(20n)
  })

  it('retains pending data and retries once without a new sample', () => {
    const errors: unknown[] = []
    const { clock, db, service, store } = createService(
      new ManualClock(),
      (error) => errors.push(error)
    )
    service.record(stats(10, 0))
    clock.advance(1_000)
    service.record(stats(10, 0))
    db.exec(`
      CREATE TRIGGER fail_transfer_bucket
      BEFORE INSERT ON transfer_buckets
      BEGIN
        SELECT RAISE(ABORT, 'retry me');
      END;
    `)

    clock.advance(TRANSFER_CHECKPOINT_MS)
    expect(errors).toHaveLength(1)
    expect(clock.timerCount).toBe(1)
    expect(currentDaySnapshot(service).today.downloadBytes).toBe('10')
    expect(store.readTotals().downloadBytes).toBe(0n)

    clock.advance(TRANSFER_CHECKPOINT_MS)
    expect(errors).toHaveLength(2)
    expect(clock.timerCount).toBe(1)
    expect(store.readTotals().downloadBytes).toBe(0n)

    db.exec('DROP TRIGGER fail_transfer_bucket')
    clock.advance(TRANSFER_CHECKPOINT_MS)

    expect(clock.timerCount).toBe(0)
    expect(store.readTotals().downloadBytes).toBe(10n)
    expect(currentDaySnapshot(service).today.downloadBytes).toBe('10')
  })

  it('flushes on dispose and reports final persistence failure', () => {
    const healthy = createService()
    healthy.service.record(stats(10, 0))
    healthy.clock.advance(1_000)
    healthy.service.record(stats(10, 0))
    expect(healthy.service.dispose()).toBe(true)
    expect(healthy.clock.timerCount).toBe(0)
    expect(healthy.store.readTotals().downloadBytes).toBe(10n)

    const errors: unknown[] = []
    const failing = createService(new ManualClock(), (error) =>
      errors.push(error)
    )
    failing.service.record(stats(10, 0))
    failing.clock.advance(1_000)
    failing.service.record(stats(10, 0))
    failing.db.exec(`
      CREATE TRIGGER fail_transfer_bucket
      BEFORE INSERT ON transfer_buckets
      BEGIN
        SELECT RAISE(ABORT, 'dispose failure');
      END;
    `)

    expect(() => failing.service.dispose()).not.toThrow()
    expect(failing.service.dispose()).toBe(false)
    expect(errors).toHaveLength(1)
    expect(failing.clock.timerCount).toBe(0)
  })
})

describe('TransferStatsService snapshots and retention', () => {
  it.each([23, 24, 25])('accepts an aligned %s-hour Today range', (hours) => {
    const { service } = createService()
    expect(() =>
      service.snapshot({
        dayStartMs: BASE_DAY,
        dayEndMs: BASE_DAY + hours * 60 * 60 * 1_000,
      })
    ).not.toThrow()
  })

  it('accepts aligned quarter-hour timezones and rejects unaligned bounds', () => {
    const { service } = createService()
    const nepalMidnightUtc = BASE_DAY + 18 * 60 * 60 * 1_000 + 15 * 60 * 1_000
    const chathamMidnightUtc = BASE_DAY + 11 * 60 * 60 * 1_000 + 15 * 60 * 1_000

    for (const start of [nepalMidnightUtc, chathamMidnightUtc]) {
      expect(() =>
        service.snapshot({
          dayStartMs: start,
          dayEndMs: start + DAY_MS,
        })
      ).not.toThrow()
    }

    expect(() =>
      service.snapshot({
        dayStartMs: BASE_DAY + 1,
        dayEndMs: BASE_DAY + DAY_MS + 1,
      })
    ).toThrow(/align/)
  })

  it('merges pending bytes and reports partial coverage metadata', () => {
    const clock = new ManualClock()
    clock.wallMs = BASE_DAY + 60_000
    const { service } = createService(clock)
    service.record(stats(10, 2))
    clock.advance(1_000)
    service.record(stats(10, 2))

    expect(currentDaySnapshot(service)).toMatchObject({
      today: {
        downloadBytes: '10',
        uploadBytes: '2',
        startedAt: BASE_DAY,
        endsAt: BASE_DAY + DAY_MS,
        coverageStartedAt: BASE_DAY + 60_000,
      },
      allTime: {
        downloadBytes: '10',
        uploadBytes: '2',
        startedAt: BASE_DAY + 60_000,
        coverageStartedAt: BASE_DAY + 60_000,
      },
      updatedAt: BASE_DAY + 61_000,
    })
  })

  it('prunes old buckets without reducing All Time', () => {
    const clock = new ManualClock()
    const { store } = freshStore(clock)
    const oldBucket = BASE_DAY - TRANSFER_RETENTION_MS - TRANSFER_BUCKET_MS
    store.checkpoint(
      new Map([
        [
          oldBucket,
          {
            downloadBytes: 30n,
            uploadBytes: 5n,
          },
        ],
        [
          BASE_DAY,
          {
            downloadBytes: 10n,
            uploadBytes: 2n,
          },
        ],
      ]),
      BASE_DAY
    )

    const service = new TransferStatsService(store, {
      wallNow: clock.wallNow,
      monotonicNow: clock.monotonicNow,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })

    expect(store.readBuckets(oldBucket, BASE_DAY + TRANSFER_BUCKET_MS)).toEqual(
      [
        {
          bucketStartMs: BASE_DAY,
          downloadBytes: 10n,
          uploadBytes: 2n,
          updatedAt: BASE_DAY,
        },
      ]
    )
    expect(currentDaySnapshot(service)).toMatchObject({
      today: {
        downloadBytes: '10',
        uploadBytes: '2',
      },
      allTime: {
        downloadBytes: '40',
        uploadBytes: '7',
      },
    })
  })

  it('does not prune buckets or publish a future timestamp after a transient wall-clock jump', () => {
    const clock = new ManualClock()
    const { store } = freshStore(clock)
    const retainedBucket = BASE_DAY - TRANSFER_RETENTION_MS + TRANSFER_BUCKET_MS
    store.checkpoint(
      new Map([
        [
          retainedBucket,
          {
            downloadBytes: 30n,
            uploadBytes: 5n,
          },
        ],
      ]),
      BASE_DAY
    )
    const service = new TransferStatsService(store, {
      wallNow: clock.wallNow,
      monotonicNow: clock.monotonicNow,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })

    service.record(stats(10, 2))
    clock.advanceMonotonic(1_000)
    clock.jumpWall(366 * DAY_MS)
    service.record(stats(10, 2))

    expect(
      store.readBuckets(retainedBucket, retainedBucket + TRANSFER_BUCKET_MS)
    ).toHaveLength(1)
    expect(currentDaySnapshot(service).updatedAt).toBe(BASE_DAY)
  })
})
