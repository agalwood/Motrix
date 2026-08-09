import { createNotificationOccurrenceConsumer } from '@core/notifications/occurrence-consumer'
import { MotrixDatabase, type TaskRow } from '@core/session/motrix-database'
import { OccurrenceDispatcher } from '@core/task/occurrences/occurrence-dispatcher'
import { Events } from '@shared/protocol/events'
import { TaskKind, TaskStatus, TaskType } from '@shared/types/task'
import type { OccurrenceCause } from '@shared/types/task-occurrence'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationCenter } from './notification-center'
import {
  makeDiagnosisOccurrence,
  makeLog,
  makeTerminalOccurrence,
} from './notification-test-fixtures'

/**
 * Must-reach end-to-end coverage for the notification center pipeline
 * (Task 18, spec Testing bullets) — real `MotrixDatabase` (in-memory
 * SQLite), a real `OccurrenceDispatcher`, and the real
 * `createNotificationOccurrenceConsumer` wired together exactly as
 * `main/index.ts`/`server/index.ts` wire them, minus the electron/fastify
 * shell. Each test constructs a FRESH `OccurrenceDispatcher` + consumer
 * instance where the brief calls for one, to simulate a process
 * restart/crash: only what is durably in the DB (the task row, its
 * occurrence outbox row, the notification ledger, and the notification
 * display row) survives across that boundary — no in-memory dispatcher or
 * consumer state does.
 */

function makeTaskRow(
  motrixId: string,
  overrides: Partial<TaskRow> = {}
): TaskRow {
  return {
    motrixId,
    name: motrixId,
    kind: TaskKind.Direct,
    taskType: TaskType.Http,
    category: null,
    priority: 0,
    tags: null,
    createdAt: 1700000000,
    updatedAt: 1700000001,
    finalPath: '',
    finalName: '',
    torrentMetaPath: null,
    infoHash: null,
    totalBytes: 0,
    downloadedBytes: 0,
    sizeWhenDone: 0,
    fileCount: 0,
    isPrivate: false,
    trackers: [],
    pieceLength: 0,
    aggStatus: TaskStatus.Queued,
    finishedAt: null,
    errorMessage: null,
    errorCode: null,
    errorDetailKey: null,
    errorDetailParams: null,
    diagnosisRevision: 0,
    uploadedBytesBaseline: 0,
    source: 'user',
    sourceMeta: null,
    ...overrides,
  }
}

describe('notification-center e2e must-reach (core-level, real db + dispatcher)', () => {
  let db: MotrixDatabase

  beforeEach(() => {
    db = new MotrixDatabase(':memory:')
    db.init()
  })

  afterEach(() => {
    db.close()
  })

  function makeCenter(emit: (channel: string, payload?: unknown) => void) {
    return new NotificationCenter({
      store: db,
      emit,
      log: makeLog(),
    })
  }

  function makeDispatcher() {
    return new OccurrenceDispatcher({
      listUndispatched: () => db.listUndispatchedOccurrences(),
      markDispatched: (id) => db.markOccurrenceDispatched(id),
      log: makeLog(),
    })
  }

  function registerNotificationConsumer(
    dispatcher: OccurrenceDispatcher,
    center: NotificationCenter
  ) {
    const consumer = createNotificationOccurrenceConsumer({
      center,
      getTaskName: () => null,
    })
    dispatcher.register(consumer.name, consumer.consume)
  }

  it('crash before dispatch: a persisted-but-undispatched occurrence drains to exactly one unread row', async () => {
    const task = makeTaskRow('task-crash-before')
    const occ = makeTerminalOccurrence({
      occurrenceId: 'occ-crash-before',
      taskId: 'task-crash-before',
    })
    // Simulates the process dying right after the transactional write that
    // commits the task + its outbox row, before any OccurrenceDispatcher
    // ever ran against it — nothing has consumed this occurrence yet.
    db.persistTaskWithOccurrence({ task, instances: [] }, occ)

    // A brand new process: fresh dispatcher, fresh consumer, fresh
    // NotificationCenter — all built only from the durable DB state.
    const center = makeCenter(vi.fn())
    const dispatcher = makeDispatcher()
    registerNotificationConsumer(dispatcher, center)

    await dispatcher.drainAtStartup()

    const rows = center.list()
    expect(rows).toHaveLength(1)
    expect(rows[0].sourceKey).toBe('occ-crash-before')
    expect(rows[0].readAt).toBeNull()
  })

  it('crash after dispatch / replay: draining again produces no second row and no second NotificationAdded', async () => {
    const task = makeTaskRow('task-crash-after')
    const occ = makeTerminalOccurrence({
      occurrenceId: 'occ-crash-after',
      taskId: 'task-crash-after',
    })
    db.persistTaskWithOccurrence({ task, instances: [] }, occ)

    const emit = vi.fn()
    const center = makeCenter(emit)
    const dispatcher = makeDispatcher()
    registerNotificationConsumer(dispatcher, center)

    await dispatcher.drainAtStartup()
    expect(center.list()).toHaveLength(1)
    expect(
      emit.mock.calls.filter((c) => c[0] === Events.NotificationAdded)
    ).toHaveLength(1)

    // Second startup drain against the SAME durable state: the row was
    // already stamped dispatched_at by the first drain, so
    // listUndispatchedOccurrences() has nothing left to redeliver — this is
    // what a crash-after-dispatch restart (or a plain repeated drain) looks
    // like from the DB's point of view.
    await dispatcher.drainAtStartup()

    expect(center.list()).toHaveLength(1)
    expect(
      emit.mock.calls.filter((c) => c[0] === Events.NotificationAdded)
    ).toHaveLength(1)
  })

  it('notify -> clearNotifications() -> replay of the same occurrence does not reinsert (ledger survives clear)', async () => {
    const task = makeTaskRow('task-replay')
    const occ = makeTerminalOccurrence({
      occurrenceId: 'occ-replay',
      taskId: 'task-replay',
    })
    db.persistTaskWithOccurrence({ task, instances: [] }, occ)

    const center = makeCenter(vi.fn())
    const dispatcher = makeDispatcher()
    registerNotificationConsumer(dispatcher, center)

    await dispatcher.dispatch(occ)
    expect(center.list()).toHaveLength(1)

    center.clear()
    expect(center.list()).toHaveLength(0)

    // Replay: redeliver the SAME occurrence directly — this bypasses the
    // "already dispatched" filter listUndispatchedOccurrences() would
    // otherwise apply, standing in for an at-least-once redelivery. The
    // ledger (`notification_occurrences`) is untouched by clear() and still
    // remembers this sourceKey, so the cleared row must not come back.
    await dispatcher.dispatch(occ)

    expect(center.list()).toHaveLength(0)
  })

  it('producer matrix: one row per non-cancel occurrence (engine/finalize/media/recovery errors + one completed), zero for user-cancel', async () => {
    const center = makeCenter(vi.fn())
    const dispatcher = makeDispatcher()
    registerNotificationConsumer(dispatcher, center)

    const matrix: Array<{
      cause: OccurrenceCause
      toStatus: TaskStatus.Completed | TaskStatus.Error
    }> = [
      { cause: 'engine', toStatus: TaskStatus.Error },
      { cause: 'finalize', toStatus: TaskStatus.Error },
      { cause: 'media', toStatus: TaskStatus.Error },
      { cause: 'recovery', toStatus: TaskStatus.Error },
      { cause: 'finalize', toStatus: TaskStatus.Completed },
      { cause: 'user-cancel', toStatus: TaskStatus.Error },
    ]

    matrix.forEach(({ cause, toStatus }, i) => {
      const taskId = `task-matrix-${i}`
      const occurrenceId = `occ-matrix-${i}`
      db.persistTaskWithOccurrence(
        { task: makeTaskRow(taskId), instances: [] },
        makeTerminalOccurrence({ occurrenceId, taskId, cause, toStatus })
      )
    })

    await dispatcher.drainAtStartup()

    const rows = center.list()
    expect(rows).toHaveLength(5)
    // The user-cancel occurrence (index 5) is the only one absent.
    expect(rows.some((r) => r.taskId === 'task-matrix-5')).toBe(false)
    for (let i = 0; i < 5; i++) {
      expect(rows.some((r) => r.taskId === `task-matrix-${i}`)).toBe(true)
    }
  })

  it('a diagnosis live-dispatched before its terminal row exists stays undispatched, then a later drain refines the body (F2)', async () => {
    // Narrow real variant: the task is already Error from a PRIOR boot
    // whose terminal occurrence never dispatched (crash before
    // markDispatched) — it sits in the outbox as undispatched, exactly
    // like the "crash before dispatch" test above.
    const task = makeTaskRow('task-diag-recovery', {
      aggStatus: TaskStatus.Error,
    })
    const terminalOcc = makeTerminalOccurrence({
      occurrenceId: 'occ-diag-recovery-terminal',
      taskId: 'task-diag-recovery',
      createdAt: 1000,
    })
    db.persistTaskWithOccurrence({ task, instances: [] }, terminalOcc)

    // Recovery on THIS boot sees the task already Error (fromStatus ===
    // status), so it builds no new terminal occurrence — but it still
    // produces and live-dispatches a diagnosis bound to that terminal row
    // (mirrors applyDiagnosisUpgradeRow inserting the diagnosis occurrence
    // in the same transaction as the row update, then
    // applyDiagnosisUpgrade() calling dispatcher.dispatch() directly,
    // bypassing the drain).
    const diagnosisOcc = makeDiagnosisOccurrence({
      occurrenceId: 'occ-diag-recovery-diag',
      taskId: 'task-diag-recovery',
      terminalOccurrenceId: terminalOcc.occurrenceId,
      createdAt: 1001,
    })
    db.persistTaskWithOccurrence({ task, instances: [] }, diagnosisOcc)

    const center = makeCenter(vi.fn())
    const dispatcher = makeDispatcher()
    registerNotificationConsumer(dispatcher, center)

    // Live-dispatch: the terminal row hasn't been drained yet, so there is
    // no display row for applyDiagnosisUpgrade to match — the F2 fix
    // throws instead of silently acking, so the dispatcher leaves this
    // occurrence undispatched rather than burning it on a no-op.
    await dispatcher.dispatch(diagnosisOcc)

    expect(center.list()).toHaveLength(0)
    expect(
      db.database
        .prepare(
          'SELECT dispatched_at FROM task_occurrences WHERE occurrence_id = ?'
        )
        .get(diagnosisOcc.occurrenceId)
    ).toEqual({ dispatched_at: null })

    // The next drain (post-terminal-row): the terminal occurrence dispatches
    // first (created_at ASC), inserting the display row with the stale
    // generic body; the still-undispatched diagnosis then re-applies
    // against that row within the same pass. A second drain is a no-op —
    // called here to match the "drain twice" acceptance shape and prove
    // idempotency.
    await dispatcher.drainAtStartup()
    await dispatcher.drainAtStartup()

    const rows = center.list()
    expect(rows).toHaveLength(1)
    expect(rows[0].sourceKey).toBe(terminalOcc.occurrenceId)
    expect(rows[0].bodyKey).toBe('task.error.reason.diskFull')
    expect(
      db.database
        .prepare(
          'SELECT dispatched_at FROM task_occurrences WHERE occurrence_id = ?'
        )
        .get(diagnosisOcc.occurrenceId)
    ).not.toEqual({ dispatched_at: null })
  })

  it('engine-never-ready bootstrap shape: a consumer registered before the engine gate still drains a must-reach occurrence (F5)', async () => {
    // main/index.ts's F5 fix registers the notification consumer BEFORE
    // supervisor.start() and calls drainAtStartup() from both of its early
    // returns (start() throwing, or landing in a non-Ready state) instead
    // of skipping the drain entirely. At the core layer there is no engine
    // concept at all — this test stands in for that shape by persisting a
    // must-reach occurrence from a prior boot, registering the consumer,
    // and draining WITHOUT ever running anything analogous to
    // `supervisor.start()`/restore()/recovery, which is exactly the
    // ordering the fix guarantees.
    const task = makeTaskRow('task-engine-down')
    const occ = makeTerminalOccurrence({
      occurrenceId: 'occ-engine-down',
      taskId: 'task-engine-down',
    })
    db.persistTaskWithOccurrence({ task, instances: [] }, occ)

    const center = makeCenter(vi.fn())
    const dispatcher = makeDispatcher()
    registerNotificationConsumer(dispatcher, center)

    await dispatcher.drainAtStartup()

    const rows = center.list()
    expect(rows).toHaveLength(1)
    expect(rows[0].sourceKey).toBe('occ-engine-down')
    expect(rows[0].readAt).toBeNull()
  })
})
