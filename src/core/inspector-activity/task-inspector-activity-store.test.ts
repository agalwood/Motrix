import { TaskStatus } from '@shared/types/task'
import {
  type TaskActivityCheckpoint,
  TaskHistoryAccuracy,
  TaskHistoryDelivery,
  type TaskHistoryEventInput,
  TaskHistoryEventKind,
  TaskInspectorActivityUpdateReason,
  TaskTransferSampleFlag,
} from '@shared/types/task-inspector-activity'
import { makeDownloadTask } from '@test-utils/task'
import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { migrate } from '../session/migrations'
import { TaskInspectorActivityService } from './task-inspector-activity-service'
import { TaskInspectorActivityStore } from './task-inspector-activity-store'
import { MAX_SIGNED_SQLITE_INTEGER } from './validators'

function database(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

function insertParent(db: Database.Database, taskId: string): void {
  db.prepare(
    `INSERT INTO tasks (
      motrix_id, name, task_type, created_at, updated_at
    ) VALUES (?, ?, 'http', 1, 1)`
  ).run(taskId, taskId)
}

function checkpoint(
  taskId: string,
  updatedAt: number,
  overrides: Partial<TaskActivityCheckpoint> = {}
): TaskActivityCheckpoint {
  return {
    taskId,
    updatedAt,
    activeMsDelta: 1_000,
    downloadActiveMsDelta: 1_000,
    estimatedDownloadBytesDelta: 100n,
    estimatedUploadBytesDelta: 20n,
    peakDownloadBps: 100,
    peakUploadBps: 20,
    rawSampleCountDelta: 1,
    samples: [{ t: updatedAt, down: 100, up: 20, flags: 0 }],
    ...overrides,
  }
}

function transition(
  taskId: string,
  eventOrdinal: number,
  eventKey: string,
  overrides: Partial<TaskHistoryEventInput> = {}
): TaskHistoryEventInput {
  return {
    taskId,
    eventOrdinal,
    eventKey,
    runtimeGeneration: 'runtime-1',
    occurredAt: 100 + eventOrdinal,
    occurredMonotonicMs: eventOrdinal,
    kind: TaskHistoryEventKind.Paused,
    fromStatus: TaskStatus.Downloading,
    toStatus: TaskStatus.Paused,
    accuracy: TaskHistoryAccuracy.Exact,
    delivery: TaskHistoryDelivery.Initial,
    errorCode: null,
    errorMessage: null,
    errorDetailKey: null,
    errorDetailParams: null,
    ...overrides,
  }
}

describe('TaskInspectorActivityStore', () => {
  it('creates a summary idempotently and reads it after store reopen', () => {
    const db = database()
    insertParent(db, 'task-1')
    const first = new TaskInspectorActivityStore(db)
    first.ensureTask('task-1', 10)
    first.ensureTask('task-1', 20)

    const reopened = new TaskInspectorActivityStore(db)
    expect(reopened.snapshot('task-1')).toMatchObject({
      taskId: 'task-1',
      revision: 0,
      summary: {
        trackingStartedAt: 10,
        estimatedDownloadBytes: '0',
        estimatedUploadBytes: '0',
      },
      timeline: { events: [] },
      lifetime: { points: [] },
    })
    expect(reopened.snapshot('missing')).toBeNull()
    db.close()
  })

  it('round-trips bigint totals beyond 2^53 and saturates signed int64 with a gap', () => {
    const db = database()
    insertParent(db, 'task-1')
    const store = new TaskInspectorActivityStore(db)
    store.ensureTask('task-1', 1)
    const beyondSafe = BigInt(Number.MAX_SAFE_INTEGER) + 123n
    store.checkpointBatch([
      checkpoint('task-1', 10, {
        estimatedDownloadBytesDelta: beyondSafe,
      }),
    ])
    expect(store.snapshot('task-1')?.summary.estimatedDownloadBytes).toBe(
      beyondSafe.toString()
    )

    store.checkpointBatch([
      checkpoint('task-1', 20, {
        estimatedDownloadBytesDelta: MAX_SIGNED_SQLITE_INTEGER,
      }),
    ])
    expect(store.snapshot('task-1')).toMatchObject({
      summary: {
        estimatedDownloadBytes: MAX_SIGNED_SQLITE_INTEGER.toString(),
        coverageGapAt: 20,
      },
    })
    db.close()
  })

  it('rolls back a transition, watermark, and revision atomically', () => {
    const db = database()
    insertParent(db, 'task-1')
    const store = new TaskInspectorActivityStore(db)
    store.ensureTask('task-1', 1)
    db.exec(
      `CREATE TRIGGER reject_history
       BEFORE INSERT ON task_history_events
       BEGIN
         SELECT RAISE(ABORT, 'injected event failure');
       END`
    )

    expect(() =>
      store.recordTransition(transition('task-1', 1, 'pause-1'))
    ).toThrow(/injected event failure/)
    expect(store.snapshot('task-1')).toMatchObject({
      revision: 0,
      summary: { lastEventOrdinal: 0 },
      timeline: { events: [] },
    })
    db.close()
  })

  it('commits healthy tasks after a poison task aborts the batch fast path', () => {
    const db = database()
    insertParent(db, 'healthy')
    insertParent(db, 'poison')
    const store = new TaskInspectorActivityStore(db)
    store.ensureTask('healthy', 1)
    store.ensureTask('poison', 1)
    db.exec(
      `CREATE TRIGGER poison_sample
       BEFORE INSERT ON task_transfer_samples
       WHEN NEW.motrix_id = 'poison'
       BEGIN
         SELECT RAISE(ABORT, 'poison');
       END`
    )

    const result = store.checkpointBatch([
      checkpoint('healthy', 10),
      checkpoint('poison', 10),
    ])

    expect(result.revisions).toEqual([
      {
        taskId: 'healthy',
        revision: 1,
        reason: TaskInspectorActivityUpdateReason.Checkpoint,
      },
    ])
    expect(result.omissions).toEqual([
      {
        taskId: 'poison',
        error: expect.any(Error),
      },
    ])
    expect(store.snapshot('healthy')?.revision).toBe(1)
    expect(store.snapshot('poison')?.revision).toBe(0)
    db.close()
  })

  it('reports one poison-task checkpoint error while healthy work commits and poison retries', () => {
    const db = database()
    insertParent(db, 'healthy')
    insertParent(db, 'poison')
    const store = new TaskInspectorActivityStore(db)
    let wall = 1_000
    let monotonic = 1_000
    const onError = vi.fn()
    const service = new TaskInspectorActivityService(store, {
      wallNow: () => wall,
      monotonicNow: () => monotonic,
      onError,
    })
    const tasks = ['healthy', 'poison'].map((id) =>
      makeDownloadTask({
        id,
        status: TaskStatus.Downloading,
        downloadSpeed: 100,
        uploadSpeed: 20,
      })
    )
    service.recordSamples(tasks)
    wall = 2_000
    monotonic = 2_000
    service.recordSamples(tasks)
    db.exec(
      `CREATE TRIGGER poison_sample
       BEFORE INSERT ON task_transfer_samples
       WHEN NEW.motrix_id = 'poison'
       BEGIN
         SELECT RAISE(ABORT, 'poison');
       END`
    )

    service.forceCheckpoint()

    expect(store.snapshot('healthy')?.revision).toBe(1)
    expect(store.snapshot('poison')?.revision).toBe(0)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      operation: 'checkpoint_task',
      taskId: 'poison',
    })

    db.exec('DROP TRIGGER poison_sample')
    service.forceCheckpoint()

    expect(store.snapshot('healthy')?.revision).toBe(1)
    expect(store.snapshot('poison')?.revision).toBe(1)
    expect(onError).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('coalesces same-ms samples and returns a complete ordered bounded series', () => {
    const db = database()
    insertParent(db, 'task-1')
    const store = new TaskInspectorActivityStore(db)
    store.ensureTask('task-1', 1)
    store.checkpointBatch([
      checkpoint('task-1', 200, {
        samples: Array.from({ length: 100 }, (_, index) => ({
          t: index + 1,
          down: index,
          up: 100 - index,
          flags: 0,
        })),
      }),
    ])
    expect(store.snapshot('task-1')?.lifetime.points).toHaveLength(72)
    store.checkpointBatch([
      checkpoint('task-1', 201, {
        samples: [
          {
            t: 200,
            down: 1,
            up: 2,
            flags: TaskTransferSampleFlag.StatusBoundary,
          },
          {
            t: 200,
            down: 8,
            up: 9,
            flags: TaskTransferSampleFlag.Terminal,
          },
        ],
      }),
    ])

    const points = store.snapshot('task-1')?.lifetime.points ?? []
    expect(points).toHaveLength(73)
    expect(points.map((point) => point.t)).toEqual(
      [...points.map((point) => point.t)].sort((a, b) => a - b)
    )
    expect(points.filter((point) => point.t === 200)).toEqual([
      {
        t: 200,
        down: 8,
        up: 9,
        flags:
          TaskTransferSampleFlag.StatusBoundary |
          TaskTransferSampleFlag.Terminal,
      },
    ])
    db.close()
  })

  it('records repeated same-ms transitions, enforces pair idempotency, and advances revisions', () => {
    const db = database()
    insertParent(db, 'task-1')
    const store = new TaskInspectorActivityStore(db)
    store.ensureTask('task-1', 1)

    expect(
      store.recordTransition(
        transition('task-1', 1, 'pause-1', { occurredAt: 100 })
      )
    ).toMatchObject({ revision: 1 })
    expect(
      store.recordTransition(
        transition('task-1', 2, 'resume-1', {
          occurredAt: 100,
          kind: TaskHistoryEventKind.Resumed,
          fromStatus: TaskStatus.Paused,
          toStatus: TaskStatus.Downloading,
        })
      )
    ).toMatchObject({ revision: 2 })
    expect(
      store.recordTransition(
        transition('task-1', 2, 'resume-1', {
          occurredAt: 100,
          kind: TaskHistoryEventKind.Resumed,
          fromStatus: TaskStatus.Paused,
          toStatus: TaskStatus.Downloading,
          delivery: TaskHistoryDelivery.Retry,
        })
      )
    ).toBeNull()
    expect(() =>
      store.recordTransition(transition('task-1', 2, 'conflict'))
    ).toThrow(/conflict/i)
    expect(store.snapshot('task-1')?.timeline.events).toHaveLength(2)
    db.close()
  })

  it('round-trips errorDetailKey/errorDetailParams and degrades malformed JSON to null', () => {
    const db = database()
    insertParent(db, 'task-1')
    const store = new TaskInspectorActivityStore(db)
    store.ensureTask('task-1', 1)

    store.recordTransition(
      transition('task-1', 1, 'failed-1', {
        kind: TaskHistoryEventKind.Failed,
        fromStatus: TaskStatus.Downloading,
        toStatus: TaskStatus.Error,
        errorDetailKey: 'task.error.detail.filesMissing',
        errorDetailParams: { cause: 'missing' },
      })
    )

    expect(store.snapshot('task-1')?.timeline.events[0]).toMatchObject({
      errorDetailKey: 'task.error.detail.filesMissing',
      errorDetailParams: { cause: 'missing' },
    })

    db.prepare(
      `UPDATE task_history_events SET error_detail_params = ? WHERE event_ordinal = 1`
    ).run('not json')
    expect(
      store.snapshot('task-1')?.timeline.events[0]?.errorDetailParams
    ).toBeNull()
    db.close()
  })

  it('caps history at 512, preserves Added/latest 511, and no-ops a pruned replay', () => {
    const db = database()
    insertParent(db, 'task-1')
    const store = new TaskInspectorActivityStore(db)
    store.ensureTask('task-1', 1)
    store.recordTransition(
      transition('task-1', 1, 'added', {
        kind: TaskHistoryEventKind.Added,
        fromStatus: null,
        toStatus: TaskStatus.Queued,
      })
    )
    for (let ordinal = 2; ordinal <= 513; ordinal += 1) {
      const paused = ordinal % 2 === 0
      store.recordTransition(
        transition('task-1', ordinal, `event-${ordinal}`, {
          kind: paused
            ? TaskHistoryEventKind.Paused
            : TaskHistoryEventKind.Resumed,
          fromStatus: paused ? TaskStatus.Downloading : TaskStatus.Paused,
          toStatus: paused ? TaskStatus.Paused : TaskStatus.Downloading,
        })
      )
    }

    const snapshot = store.snapshot('task-1')
    expect(snapshot?.timeline.events).toHaveLength(512)
    expect(snapshot?.timeline.events[0]?.kind).toBe(TaskHistoryEventKind.Added)
    expect(
      snapshot?.timeline.events.some((event) => event.eventOrdinal === 2)
    ).toBe(false)
    expect(snapshot?.summary).toMatchObject({
      lastEventOrdinal: 513,
      historyDroppedCount: 1,
      historyTruncatedAt: 102,
    })
    expect(
      store.recordTransition(
        transition('task-1', 2, 'event-2', {
          delivery: TaskHistoryDelivery.Retry,
        })
      )
    ).toBeNull()
    db.close()
  })

  it('rejects malformed inputs and cascades snapshots with the parent task', () => {
    const db = database()
    insertParent(db, 'task-1')
    const store = new TaskInspectorActivityStore(db)
    expect(() => store.ensureTask('', 1)).toThrow(RangeError)
    store.ensureTask('task-1', 1)
    expect(() =>
      store.checkpointBatch([
        checkpoint('task-1', 10, { estimatedUploadBytesDelta: -1n }),
      ])
    ).toThrow(RangeError)
    expect(() =>
      store.recordTransition(transition('task-1', 2, 'gap'))
    ).toThrow(/ordinal gap/i)

    db.prepare("DELETE FROM tasks WHERE motrix_id = 'task-1'").run()
    expect(store.snapshot('task-1')).toBeNull()
    db.close()
  })
})
