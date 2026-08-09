import { Events } from '@shared/protocol/events'
import type { GlobalStats } from '@shared/types/stats'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../events/event-bus'
import { v1 } from '../session/migrations/v1'
import { TransferStatsRuntime } from './transfer-stats-runtime'
import { TRANSFER_CHECKPOINT_MS } from './transfer-stats-service'

const DAY_MS = 24 * 60 * 60 * 1000
const BASE_DAY = DAY_MS * 20_000
const openedDatabases: Database.Database[] = []

class RuntimeClock {
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
    for (const [id, timer] of [...this.timers]) {
      if (timer.dueAt <= this.monotonicMs) {
        this.timers.delete(id)
        timer.callback()
      }
    }
  }
}

function freshDatabase(): Database.Database {
  const db = new Database(':memory:')
  openedDatabases.push(db)
  db.pragma('foreign_keys = ON')
  db.transaction(() => v1.up(db))()
  return db
}

function stats(downloadSpeed: number, uploadSpeed = 0): GlobalStats {
  return {
    totalDownloadSpeed: downloadSpeed,
    totalUploadSpeed: uploadSpeed,
    activeTasks: 0,
    waitingTasks: 0,
    stoppedTasks: 0,
  }
}

function snapshot(runtime: TransferStatsRuntime) {
  return runtime.snapshot({
    dayStartMs: BASE_DAY,
    dayEndMs: BASE_DAY + DAY_MS,
  })
}

afterEach(() => {
  for (const db of openedDatabases.splice(0)) {
    if (db.open) db.close()
  }
})

describe('TransferStatsRuntime', () => {
  it('flushes on disconnect and clears baselines across recovery', () => {
    const db = freshDatabase()
    const eventBus = new EventBus()
    const clock = new RuntimeClock()
    const runtime = new TransferStatsRuntime(db, eventBus, {
      wallNow: clock.wallNow,
      monotonicNow: clock.monotonicNow,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })

    runtime.record(stats(10))
    clock.advance(1_000)
    runtime.record(stats(10))
    eventBus.emit(Events.EngineDisconnected)

    expect(
      (
        db
          .prepare('SELECT download_bytes FROM transfer_totals WHERE id = 1')
          .safeIntegers()
          .get() as { download_bytes: bigint }
      ).download_bytes
    ).toBe(10n)

    clock.advance(4_000)
    eventBus.emit(Events.EngineRecovered)
    runtime.record(stats(100))
    clock.advance(1_000)
    runtime.record(stats(100))

    expect(snapshot(runtime).allTime.downloadBytes).toBe('110')
    expect(runtime.dispose()).toBe(true)
  })

  it('uses the same listener identities for registration and cleanup', () => {
    const db = freshDatabase()
    const eventBus = new EventBus()
    const on = vi.spyOn(eventBus, 'on')
    const off = vi.spyOn(eventBus, 'off')
    const clock = new RuntimeClock()
    const runtime = new TransferStatsRuntime(db, eventBus, {
      wallNow: clock.wallNow,
      monotonicNow: clock.monotonicNow,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })
    const disconnectedListener = on.mock.calls.find(
      ([channel]) => channel === Events.EngineDisconnected
    )?.[1]
    const recoveredListener = on.mock.calls.find(
      ([channel]) => channel === Events.EngineRecovered
    )?.[1]

    runtime.dispose()

    expect(off).toHaveBeenCalledWith(
      Events.EngineDisconnected,
      disconnectedListener
    )
    expect(off).toHaveBeenCalledWith(Events.EngineRecovered, recoveredListener)
  })

  it('never throws persistence failures from EventBus and retries later', () => {
    const db = freshDatabase()
    const eventBus = new EventBus()
    const clock = new RuntimeClock()
    const errors: unknown[] = []
    const runtime = new TransferStatsRuntime(db, eventBus, {
      wallNow: clock.wallNow,
      monotonicNow: clock.monotonicNow,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onError: (error) => errors.push(error),
    })
    runtime.record(stats(10))
    clock.advance(1_000)
    runtime.record(stats(10))
    db.exec(`
      CREATE TRIGGER fail_transfer_bucket
      BEFORE INSERT ON transfer_buckets
      BEGIN
        SELECT RAISE(ABORT, 'runtime failure');
      END;
    `)

    expect(() => eventBus.emit(Events.EngineDisconnected)).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(snapshot(runtime).allTime.downloadBytes).toBe('10')

    db.exec('DROP TRIGGER fail_transfer_bucket')
    clock.advance(TRANSFER_CHECKPOINT_MS)

    expect(snapshot(runtime).allTime.downloadBytes).toBe('10')
    expect(
      (
        db
          .prepare('SELECT download_bytes FROM transfer_totals WHERE id = 1')
          .safeIntegers()
          .get() as { download_bytes: bigint }
      ).download_bytes
    ).toBe(10n)
    expect(runtime.dispose()).toBe(true)
  })

  it('unbinds listeners before reporting a failed final flush', () => {
    const db = freshDatabase()
    const eventBus = new EventBus()
    const off = vi.spyOn(eventBus, 'off')
    const clock = new RuntimeClock()
    const errors: unknown[] = []
    const runtime = new TransferStatsRuntime(db, eventBus, {
      wallNow: clock.wallNow,
      monotonicNow: clock.monotonicNow,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onError: (error) => errors.push(error),
    })
    runtime.record(stats(10))
    clock.advance(1_000)
    runtime.record(stats(10))
    db.exec(`
      CREATE TRIGGER fail_transfer_bucket
      BEFORE INSERT ON transfer_buckets
      BEGIN
        SELECT RAISE(ABORT, 'shutdown failure');
      END;
    `)

    expect(runtime.dispose()).toBe(false)
    expect(runtime.dispose()).toBe(false)
    expect(off).toHaveBeenCalledTimes(2)
    expect(errors).toHaveLength(1)

    expect(() => eventBus.emit(Events.EngineDisconnected)).not.toThrow()
    expect(errors).toHaveLength(1)
  })
})
