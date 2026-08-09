import { type EventChannel, Events } from '@shared/protocol/events'
import {
  TaskActivityAccuracy,
  TaskActivityKind,
  type TaskActivitySnapshot,
  type TaskActivityUpdatedPayload,
} from '@shared/types/task-activity'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { v1 } from '../session/migrations/v1'
import { TaskActivityService } from './task-activity-service'
import { TaskActivityStore } from './task-activity-store'

const HOUR_MS = 60 * 60 * 1_000
const DAY_MS = 24 * HOUR_MS
const BASE_MS = Date.UTC(2025, 0, 1)
const ONE_DAY = {
  days: [
    {
      dateKey: '2025-01-01',
      fromMs: BASE_MS,
      toMs: BASE_MS + DAY_MS,
    },
  ],
}

describe('TaskActivityService', () => {
  let db: Database.Database
  let store: TaskActivityStore
  let emitted: TaskActivityUpdatedPayload[]
  let eventEmitter: {
    emit(channel: EventChannel, ...args: unknown[]): void
  }
  let service: TaskActivityService

  beforeEach(() => {
    db = new Database(':memory:')
    db.transaction(() => v1.up(db))()
    store = new TaskActivityStore(db)
    emitted = []
    eventEmitter = {
      emit: vi.fn((channel: EventChannel, ...args: unknown[]) => {
        const payload = args[0] as TaskActivityUpdatedPayload
        expect(channel).toBe(Events.TaskActivityUpdated)
        emitted.push(payload)
      }),
    }
    service = new TaskActivityService(store, eventEmitter)
  })

  afterEach(() => {
    db.close()
  })

  it('aggregates exact and recovered events into bounded daily counts', () => {
    service.recordSubmitted({
      taskId: 'submitted',
      occurredAt: BASE_MS + HOUR_MS,
    })
    service.recordDownloadCompleted({
      taskId: 'exact',
      occurredAt: BASE_MS + 2 * HOUR_MS,
    })
    service.recordDownloadCompleted({
      taskId: 'recovered',
      occurredAt: BASE_MS + 3 * HOUR_MS,
      accuracy: TaskActivityAccuracy.Recovered,
    })

    expect(service.snapshot(ONE_DAY).days).toEqual([
      {
        dateKey: '2025-01-01',
        submitted: 1,
        downloadCompleted: 2,
        recoveredDownloadCompleted: 1,
      },
    ])
    expect(emitted.map((payload) => payload.revision)).toEqual([1, 2, 3])
    expect(new Set(emitted.map((payload) => payload.generation))).toEqual(
      new Set([service.snapshot(ONE_DAY).generation])
    )
  })

  it('keeps boundary instants in the later half-open day', () => {
    service.recordSubmitted({
      taskId: 'boundary',
      occurredAt: BASE_MS + DAY_MS,
    })

    const snapshot = service.snapshot({
      days: [
        ONE_DAY.days[0],
        {
          dateKey: '2025-01-02',
          fromMs: BASE_MS + DAY_MS,
          toMs: BASE_MS + 2 * DAY_MS,
        },
      ],
    })
    expect(snapshot.days.map((day) => day.submitted)).toEqual([0, 1])
  })

  it('accepts contiguous DST-sized boundaries', () => {
    const springEnd = BASE_MS + 23 * HOUR_MS
    expect(() =>
      service.snapshot({
        days: [
          {
            dateKey: '2025-03-09',
            fromMs: BASE_MS,
            toMs: springEnd,
          },
          {
            dateKey: '2025-11-02',
            fromMs: springEnd,
            toMs: springEnd + 25 * HOUR_MS,
          },
        ],
      })
    ).not.toThrow()
  })

  it('returns empty tracked days with partial coverage metadata', () => {
    db.prepare(
      `UPDATE task_activity_meta
       SET tracking_started_at = ?, coverage_gap_at = ?
       WHERE id = 1`
    ).run(BigInt(BASE_MS + 12 * HOUR_MS), BigInt(BASE_MS + 18 * HOUR_MS))

    expect(service.snapshot(ONE_DAY)).toMatchObject({
      revision: 0,
      coverage: {
        trackingStartedAt: BASE_MS + 12 * HOUR_MS,
        coverageGapAt: BASE_MS + 18 * HOUR_MS,
      },
      days: [
        {
          dateKey: '2025-01-01',
          submitted: 0,
          downloadCompleted: 0,
          recoveredDownloadCompleted: 0,
        },
      ],
    })
  })

  it('suppresses duplicate writes and duplicate update events', () => {
    const input = { taskId: 'duplicate', occurredAt: BASE_MS + 1 }
    service.recordSubmitted(input)
    service.recordSubmitted({ ...input, occurredAt: BASE_MS + 2 })

    expect(emitted).toHaveLength(1)
    expect(service.snapshot(ONE_DAY).revision).toBe(1)
  })

  it('persists a pending coverage gap before the next query', () => {
    const readSnapshot: TaskActivitySnapshot = {
      generation: 'generation-1',
      revision: 7,
      coverage: {
        trackingStartedAt: BASE_MS,
        coverageGapAt: BASE_MS + 10,
      },
      days: [],
    }
    const error = new Error('insert unavailable')
    const coverageError = new Error('coverage write unavailable')
    const failingStore = {
      record: vi.fn(() => {
        throw error
      }),
      markCoverageGap: vi
        .fn()
        .mockImplementationOnce(() => {
          throw coverageError
        })
        .mockReturnValueOnce({
          generation: 'generation-1',
          revision: 7,
          coverageGapAt: BASE_MS + 10,
        }),
      snapshot: vi.fn(() => readSnapshot),
    } as unknown as TaskActivityStore
    const onError = vi.fn()
    const emitter = { emit: vi.fn() }
    const failingService = new TaskActivityService(failingStore, emitter, {
      onError,
    })

    expect(() =>
      failingService.recordSubmitted({
        taskId: 'missed',
        occurredAt: BASE_MS + 10,
      })
    ).not.toThrow()
    expect(failingStore.markCoverageGap).toHaveBeenCalledOnce()

    expect(failingService.snapshot(ONE_DAY)).toBe(readSnapshot)
    expect(failingStore.markCoverageGap).toHaveBeenCalledTimes(2)
    expect(failingStore.markCoverageGap).toHaveBeenLastCalledWith(BASE_MS + 10)
    expect(emitter.emit).toHaveBeenCalledWith(
      Events.TaskActivityUpdated,
      expect.objectContaining({
        type: 'coverage_degraded',
        generation: 'generation-1',
        revision: 7,
        coverageGapAt: BASE_MS + 10,
      })
    )
    expect(onError).toHaveBeenCalledWith(error, { operation: 'record' })
    expect(onError).toHaveBeenCalledWith(coverageError, {
      operation: 'persist_coverage_gap',
    })
  })

  it('exposes a pending gap when coverage persistence remains unavailable', () => {
    const readSnapshot: TaskActivitySnapshot = {
      generation: 'generation-1',
      revision: 0,
      coverage: {
        trackingStartedAt: BASE_MS,
        coverageGapAt: null,
      },
      days: [],
    }
    const failingStore = {
      record: vi.fn(() => {
        throw new Error('insert unavailable')
      }),
      markCoverageGap: vi.fn(() => {
        throw new Error('coverage write unavailable')
      }),
      snapshot: vi.fn(() => readSnapshot),
    } as unknown as TaskActivityStore
    const failingService = new TaskActivityService(failingStore, {
      emit: vi.fn(),
    })

    failingService.recordSubmitted({
      taskId: 'missed',
      occurredAt: BASE_MS + 10,
    })

    expect(failingService.snapshot(ONE_DAY)).toEqual({
      ...readSnapshot,
      coverage: {
        ...readSnapshot.coverage,
        coverageGapAt: BASE_MS + 10,
      },
    })
  })

  it('isolates listener and error-reporter failures from lifecycle writes', () => {
    const onError = vi.fn(() => {
      throw new Error('reporter failed')
    })
    const throwingEmitter = {
      emit: vi.fn(() => {
        throw new Error('listener failed')
      }),
    }
    const resilientService = new TaskActivityService(store, throwingEmitter, {
      onError,
    })

    expect(() =>
      resilientService.recordDownloadCompleted({
        taskId: 'completed',
        occurredAt: BASE_MS + 1,
      })
    ).not.toThrow()
    expect(resilientService.snapshot(ONE_DAY)).toMatchObject({
      revision: 1,
      coverage: { coverageGapAt: null },
      days: [{ downloadCompleted: 1 }],
    })
    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      operation: 'emit_update',
    })
  })

  it('propagates query validation and store read failures', () => {
    const snapshotError = new Error('read unavailable')
    const failingStore = {
      snapshot: vi.fn(() => {
        throw snapshotError
      }),
      markCoverageGap: vi.fn(),
    } as unknown as TaskActivityStore
    const queryService = new TaskActivityService(failingStore, {
      emit: vi.fn(),
    })

    expect(() => queryService.snapshot({ days: [] })).toThrow()
    expect(failingStore.snapshot).not.toHaveBeenCalled()
    expect(() => queryService.snapshot(ONE_DAY)).toThrow(snapshotError)
  })

  it('emits renderer-safe event payloads without task identifiers', () => {
    service.recordDownloadCompleted({
      taskId: 'private-task-id',
      occurredAt: BASE_MS + 1,
      accuracy: TaskActivityAccuracy.Recovered,
    })

    expect(emitted).toEqual([
      {
        type: 'inserted',
        generation: expect.any(String),
        revision: 1,
        event: {
          kind: TaskActivityKind.DownloadCompleted,
          occurredAt: BASE_MS + 1,
          accuracy: TaskActivityAccuracy.Recovered,
        },
      },
    ])
    expect(JSON.stringify(emitted)).not.toContain('private-task-id')
  })
})
