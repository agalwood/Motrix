import type {
  TaskActivityAccuracy,
  TaskActivityDay,
  TaskActivityDayBoundary,
  TaskActivityKind,
  TaskActivitySnapshot,
} from '@shared/types/task-activity'
import type Database from 'better-sqlite3'
import {
  nonNegativeIntegerFromBigInt,
  requireSafePositiveTimestamp,
  safeIntegerFromSql,
} from '../lib/sqlite-integers'
import { MAX_TASK_ACTIVITY_DAYS } from './validators'

export interface TaskActivityRecordInput {
  taskId: string
  kind: TaskActivityKind
  occurredAt: number
  accuracy: TaskActivityAccuracy
}

export interface TaskActivityInsertResult {
  generation: string
  revision: number
  event: {
    kind: TaskActivityKind
    occurredAt: number
    accuracy: TaskActivityAccuracy
  }
}

export interface TaskActivityCoverageChange {
  generation: string
  revision: number
  coverageGapAt: number
}

interface ActivityMetaRow {
  generation: string
  tracking_started_at: bigint
  revision: bigint
  coverage_gap_at: bigint | null
}

interface ActivityMeta {
  generation: string
  trackingStartedAt: number
  revision: number
  coverageGapAt: number | null
}

interface ActivityAggregateRow {
  day_index: bigint
  submitted: bigint
  download_completed: bigint
  recovered_download_completed: bigint
}

function requireDayCount(dayCount: number): void {
  if (
    !Number.isInteger(dayCount) ||
    dayCount < 1 ||
    dayCount > MAX_TASK_ACTIVITY_DAYS
  ) {
    throw new RangeError(
      `dayCount must be between 1 and ${MAX_TASK_ACTIVITY_DAYS}`
    )
  }
}

const INSERT_EVENT_SQL = `
  INSERT INTO task_activity_events (
    motrix_id,
    kind,
    occurred_at,
    accuracy
  ) VALUES (?, ?, ?, ?)
  ON CONFLICT(motrix_id, kind) DO NOTHING
`

const ADVANCE_REVISION_SQL = `
  UPDATE task_activity_meta
  SET revision = revision + 1
  WHERE id = 1
`

const MARK_COVERAGE_GAP_SQL = `
  UPDATE task_activity_meta
  SET
    coverage_gap_at = ?,
    revision = revision + 1
  WHERE id = 1
    AND (
      coverage_gap_at IS NULL
      OR coverage_gap_at > ?
    )
`

const READ_META_SQL = `
  SELECT
    generation,
    tracking_started_at,
    revision,
    coverage_gap_at
  FROM task_activity_meta
  WHERE id = 1
`

export function createTaskActivitySnapshotSql(dayCount: number): string {
  requireDayCount(dayCount)
  const values = Array.from(
    { length: dayCount },
    (_, index) => `(${index}, ?, ?)`
  ).join(', ')

  return `
    WITH day_bounds(day_index, from_ms, to_ms) AS (
      VALUES ${values}
    )
    SELECT
      day_bounds.day_index,
      SUM(
        CASE WHEN events.kind = 'submitted' THEN 1 ELSE 0 END
      ) AS submitted,
      SUM(
        CASE WHEN events.kind = 'download_completed' THEN 1 ELSE 0 END
      ) AS download_completed,
      SUM(
        CASE
          WHEN events.kind = 'download_completed'
            AND events.accuracy = 'recovered'
          THEN 1
          ELSE 0
        END
      ) AS recovered_download_completed
    FROM day_bounds
    LEFT JOIN task_activity_events AS events
      INDEXED BY idx_task_activity_time
      ON events.occurred_at >= day_bounds.from_ms
      AND events.occurred_at < day_bounds.to_ms
    GROUP BY day_bounds.day_index
    ORDER BY day_bounds.day_index
  `
}

export function taskActivitySnapshotBindings(
  days: readonly TaskActivityDayBoundary[]
): bigint[] {
  return days.flatMap((day) => [BigInt(day.fromMs), BigInt(day.toMs)])
}

/**
 * Append-only task activity persistence.
 *
 * All mutations that affect a renderer-visible snapshot advance the
 * generation-local revision in the same SQLite transaction.
 *
 * Structural validation of query params belongs to TaskActivityService; the
 * store trusts its typed arguments. Statements and transaction wrappers are
 * prepared once and reused — record() sits on the per-task-event path.
 */
export class TaskActivityStore {
  private readonly statements = new Map<string, Database.Statement>()
  private recordTransaction?: (
    input: TaskActivityRecordInput
  ) => TaskActivityInsertResult | null
  private coverageGapTransaction?: (
    occurredAt: number
  ) => TaskActivityCoverageChange | null
  private snapshotTransaction?: (
    days: readonly TaskActivityDayBoundary[]
  ) => TaskActivitySnapshot

  constructor(private readonly db: Database.Database) {}

  record(input: TaskActivityRecordInput): TaskActivityInsertResult | null {
    if (input.taskId.length === 0) {
      throw new RangeError('taskId must not be empty')
    }
    requireSafePositiveTimestamp(input.occurredAt, 'occurredAt')

    this.recordTransaction ??= this.db.transaction(
      (record: TaskActivityRecordInput) => {
        const inserted = this.prepared(INSERT_EVENT_SQL).run(
          record.taskId,
          record.kind,
          BigInt(record.occurredAt),
          record.accuracy
        )
        if (inserted.changes === 0) return null

        const advanced = this.prepared(ADVANCE_REVISION_SQL).run()
        if (advanced.changes !== 1) {
          throw new Error('Task activity metadata singleton is missing')
        }

        const meta = this.readMeta()
        return {
          generation: meta.generation,
          revision: meta.revision,
          event: {
            kind: record.kind,
            occurredAt: record.occurredAt,
            accuracy: record.accuracy,
          },
        }
      }
    )
    return this.recordTransaction(input)
  }

  markCoverageGap(occurredAt: number): TaskActivityCoverageChange | null {
    requireSafePositiveTimestamp(occurredAt, 'occurredAt')

    this.coverageGapTransaction ??= this.db.transaction((gapAt: number) => {
      const changed = this.prepared(MARK_COVERAGE_GAP_SQL).run(
        BigInt(gapAt),
        BigInt(gapAt)
      )
      if (changed.changes === 0) {
        const existing = this.readMeta()
        if (existing.coverageGapAt === null || existing.coverageGapAt > gapAt) {
          throw new Error('Task activity coverage gap was not persisted')
        }
        return null
      }

      const meta = this.readMeta()
      return {
        generation: meta.generation,
        revision: meta.revision,
        coverageGapAt: gapAt,
      }
    })
    return this.coverageGapTransaction(occurredAt)
  }

  snapshot(days: readonly TaskActivityDayBoundary[]): TaskActivitySnapshot {
    this.snapshotTransaction ??= this.db.transaction(
      (bounds: readonly TaskActivityDayBoundary[]) => {
        const meta = this.readMeta()
        const rows = this.prepared(createTaskActivitySnapshotSql(bounds.length))
          .safeIntegers()
          .all(
            ...taskActivitySnapshotBindings(bounds)
          ) as ActivityAggregateRow[]
        if (rows.length !== bounds.length) {
          throw new Error('Task activity aggregation returned an invalid shape')
        }

        const aggregatedDays: TaskActivityDay[] = rows.map((row, index) => {
          const dayIndex = nonNegativeIntegerFromBigInt(
            row.day_index,
            'day_index'
          )
          if (dayIndex !== index) {
            throw new Error(
              'Task activity aggregation returned invalid ordering'
            )
          }
          const boundary = bounds[dayIndex]
          if (!boundary) {
            throw new Error('Task activity aggregation returned an invalid day')
          }

          return {
            dateKey: boundary.dateKey,
            submitted: nonNegativeIntegerFromBigInt(row.submitted, 'submitted'),
            downloadCompleted: nonNegativeIntegerFromBigInt(
              row.download_completed,
              'download_completed'
            ),
            recoveredDownloadCompleted: nonNegativeIntegerFromBigInt(
              row.recovered_download_completed,
              'recovered_download_completed'
            ),
          }
        })

        return {
          generation: meta.generation,
          revision: meta.revision,
          coverage: {
            trackingStartedAt: meta.trackingStartedAt,
            coverageGapAt: meta.coverageGapAt,
          },
          days: aggregatedDays,
        }
      }
    )
    return this.snapshotTransaction(days)
  }

  private prepared(sql: string): Database.Statement {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  private readMeta(): ActivityMeta {
    const row = this.prepared(READ_META_SQL).safeIntegers().get() as
      | ActivityMetaRow
      | undefined
    if (!row) {
      throw new Error('Task activity metadata singleton is missing')
    }
    if (typeof row.generation !== 'string' || row.generation.length === 0) {
      throw new Error('Task activity generation is empty')
    }
    return {
      generation: row.generation,
      trackingStartedAt: safeIntegerFromSql(
        row.tracking_started_at,
        'tracking_started_at'
      ),
      revision: nonNegativeIntegerFromBigInt(row.revision, 'revision'),
      coverageGapAt:
        row.coverage_gap_at === null
          ? null
          : safeIntegerFromSql(row.coverage_gap_at, 'coverage_gap_at'),
    }
  }
}
