import {
  TaskActivityAccuracy,
  TaskActivityKind,
} from '@shared/types/task-activity'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { v1 } from '../session/migrations/v1'
import {
  createTaskActivitySnapshotSql,
  TaskActivityStore,
  taskActivitySnapshotBindings,
} from './task-activity-store'

const DAY_MS = 24 * 60 * 60 * 1_000
const BASE_MS = Date.UTC(2025, 0, 1)

function makeDays(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    dateKey: new Date(BASE_MS + index * DAY_MS).toISOString().slice(0, 10),
    fromMs: BASE_MS + index * DAY_MS,
    toMs: BASE_MS + (index + 1) * DAY_MS,
  }))
}

describe('TaskActivityStore', () => {
  let db: Database.Database
  let store: TaskActivityStore

  beforeEach(() => {
    db = new Database(':memory:')
    db.transaction(() => v1.up(db))()
    store = new TaskActivityStore(db)
  })

  afterEach(() => {
    db.close()
  })

  it('inserts both kinds for one task and returns monotonic revisions', () => {
    const submitted = store.record({
      taskId: 'task-1',
      kind: TaskActivityKind.Submitted,
      occurredAt: BASE_MS + 1,
      accuracy: TaskActivityAccuracy.Exact,
    })
    const completed = store.record({
      taskId: 'task-1',
      kind: TaskActivityKind.DownloadCompleted,
      occurredAt: BASE_MS + 2,
      accuracy: TaskActivityAccuracy.Recovered,
    })

    expect(submitted).toMatchObject({
      revision: 1,
      event: {
        kind: TaskActivityKind.Submitted,
        occurredAt: BASE_MS + 1,
        accuracy: TaskActivityAccuracy.Exact,
      },
    })
    expect(completed).toMatchObject({
      generation: submitted?.generation,
      revision: 2,
    })
    expect(store.snapshot(makeDays(1)).days).toEqual([
      {
        dateKey: '2025-01-01',
        submitted: 1,
        downloadCompleted: 1,
        recoveredDownloadCompleted: 1,
      },
    ])
  })

  it('returns null for a duplicate without changing revision or timestamp', () => {
    const input = {
      taskId: 'task-1',
      kind: TaskActivityKind.Submitted,
      occurredAt: BASE_MS + 1,
      accuracy: TaskActivityAccuracy.Exact,
    }
    expect(store.record(input)?.revision).toBe(1)
    expect(store.record({ ...input, occurredAt: BASE_MS + DAY_MS })).toBeNull()

    const snapshot = store.snapshot(makeDays(2))
    expect(snapshot.revision).toBe(1)
    expect(snapshot.days.map((day) => day.submitted)).toEqual([1, 0])
  })

  it('uses half-open boundaries and returns deterministic day order', () => {
    store.record({
      taskId: 'left',
      kind: TaskActivityKind.Submitted,
      occurredAt: BASE_MS,
      accuracy: TaskActivityAccuracy.Exact,
    })
    store.record({
      taskId: 'boundary',
      kind: TaskActivityKind.Submitted,
      occurredAt: BASE_MS + DAY_MS,
      accuracy: TaskActivityAccuracy.Exact,
    })

    expect(store.snapshot(makeDays(2)).days).toEqual([
      {
        dateKey: '2025-01-01',
        submitted: 1,
        downloadCompleted: 0,
        recoveredDownloadCompleted: 0,
      },
      {
        dateKey: '2025-01-02',
        submitted: 1,
        downloadCompleted: 0,
        recoveredDownloadCompleted: 0,
      },
    ])
  })

  it('rolls back the inserted event when revision advancement fails', () => {
    db.exec(`
      CREATE TRIGGER reject_activity_revision
      BEFORE UPDATE OF revision ON task_activity_meta
      BEGIN
        SELECT RAISE(ABORT, 'revision rejected');
      END;
    `)

    expect(() =>
      store.record({
        taskId: 'task-rollback',
        kind: TaskActivityKind.Submitted,
        occurredAt: BASE_MS,
        accuracy: TaskActivityAccuracy.Exact,
      })
    ).toThrow('revision rejected')
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM task_activity_events').get()
    ).toEqual({ count: 0 })
    expect(
      db.prepare('SELECT revision FROM task_activity_meta WHERE id = 1').get()
    ).toEqual({ revision: 0 })
  })

  it('persists only an earlier coverage gap and advances revision on change', () => {
    const first = store.markCoverageGap(BASE_MS + 100)
    expect(first).toMatchObject({
      revision: 1,
      coverageGapAt: BASE_MS + 100,
    })
    expect(store.markCoverageGap(BASE_MS + 200)).toBeNull()
    expect(store.markCoverageGap(BASE_MS + 100)).toBeNull()
    expect(store.markCoverageGap(BASE_MS + 50)).toMatchObject({
      generation: first?.generation,
      revision: 2,
      coverageGapAt: BASE_MS + 50,
    })
    expect(store.snapshot(makeDays(1))).toMatchObject({
      revision: 2,
      coverage: { coverageGapAt: BASE_MS + 50 },
    })
  })

  it('does not mistake missing metadata for an existing coverage gap', () => {
    db.prepare('DELETE FROM task_activity_meta WHERE id = 1').run()

    expect(() => store.markCoverageGap(BASE_MS)).toThrow(
      'Task activity metadata singleton is missing'
    )
  })

  it('uses the time-first covering index for daily aggregation', () => {
    const days = makeDays(2)
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN ${createTaskActivitySnapshotSql(days.length)}`
      )
      .all(...taskActivitySnapshotBindings(days)) as Array<{ detail: string }>

    expect(
      plan.some(
        (row) =>
          row.detail.includes(
            'SEARCH events USING COVERING INDEX idx_task_activity_time'
          ) &&
          row.detail.includes('occurred_at>?') &&
          row.detail.includes('occurred_at<?')
      )
    ).toBe(true)
    expect(plan.some((row) => row.detail.includes('SCAN events'))).toBe(false)
  })

  it('returns 371 aggregate rows for a 100,000-event range', () => {
    const insert = db.prepare(
      `INSERT INTO task_activity_events (
        motrix_id,
        kind,
        occurred_at,
        accuracy
      ) VALUES (?, 'submitted', ?, 'exact')`
    )
    db.transaction(() => {
      for (let index = 0; index < 100_000; index += 1) {
        insert.run(
          `bulk-${index}`,
          BigInt(BASE_MS + (index % 365) * DAY_MS + 1)
        )
      }
    })()

    const snapshot = store.snapshot(makeDays(371))
    expect(snapshot.days).toHaveLength(371)
    expect(snapshot.days.reduce((total, day) => total + day.submitted, 0)).toBe(
      100_000
    )
  })

  it('rejects persisted metadata outside the safe integer range', () => {
    db.prepare(
      `UPDATE task_activity_meta
       SET revision = ?
       WHERE id = 1`
    ).run(9_007_199_254_740_992n)

    expect(() => store.snapshot(makeDays(1))).toThrow(/safe integer range/)
  })
})
