import { parseDetailParams } from '@shared/task-error/detail-params'
import type { TaskStatus } from '@shared/types/task'
import {
  type TaskActivityCheckpoint,
  type TaskActivityRevision,
  type TaskHistoryAccuracy,
  type TaskHistoryEvent,
  type TaskHistoryEventInput,
  TaskHistoryEventKind,
  type TaskInspectorActivitySnapshot,
  TaskInspectorActivityUpdateReason,
  type TaskTransferSample,
} from '@shared/types/task-inspector-activity'
import type Database from 'better-sqlite3'
import {
  nonNegativeIntegerFromBigInt,
  safeIntegerFromSql,
} from '../lib/sqlite-integers'
import {
  COMPACTED_TASK_SAMPLE_COUNT,
  compactTaskTransferSamples,
  MAX_PERSISTED_TASK_SAMPLES,
} from './compaction'
import type { TaskActivityCheckpointResult } from './task-inspector-activity-service'
import {
  assertPositiveSafeInteger,
  assertTaskId,
  saturatingAddSafeInteger,
  saturatingAddSignedInt64,
  validateCheckpoint,
  validateHistoryEventInput,
} from './validators'

export const MAX_TASK_HISTORY_EVENTS = 512

interface SummaryRow {
  motrix_id: string
  tracking_started_at: bigint
  coverage_gap_at: bigint | null
  revision: bigint
  last_event_ordinal: bigint
  active_ms: bigint
  download_active_ms: bigint
  estimated_download_bytes: bigint
  estimated_upload_bytes: bigint
  peak_download_bps: bigint
  peak_upload_bps: bigint
  raw_sample_count: bigint
  history_dropped_count: bigint
  history_truncated_at: bigint | null
  updated_at: bigint
}

interface Summary {
  taskId: string
  trackingStartedAt: number
  coverageGapAt: number | null
  revision: number
  lastEventOrdinal: number
  activeMs: number
  downloadActiveMs: number
  estimatedDownloadBytes: bigint
  estimatedUploadBytes: bigint
  peakDownloadBps: number
  peakUploadBps: number
  rawSampleCount: number
  historyDroppedCount: number
  historyTruncatedAt: number | null
  updatedAt: number
}

interface HistoryRow {
  event_id: bigint
  event_ordinal: bigint
  event_key: string
  kind: TaskHistoryEventKind
  from_status: TaskStatus | null
  to_status: TaskStatus
  occurred_at: bigint
  accuracy: TaskHistoryAccuracy
  error_code: string | null
  error_message: string | null
  error_detail_key: string | null
  error_detail_params: string | null
}

interface SampleRow {
  sampled_at: bigint
  download_bps: bigint
  upload_bps: bigint
  flags: bigint
}

interface PreparedCheckpoint extends TaskActivityCheckpoint {
  taskId: string
  peakDownloadBps: number
  peakUploadBps: number
  samples: readonly TaskTransferSample[]
}

const READ_SUMMARY_SQL = `
  SELECT
    motrix_id,
    tracking_started_at,
    coverage_gap_at,
    revision,
    last_event_ordinal,
    active_ms,
    download_active_ms,
    estimated_download_bytes,
    estimated_upload_bytes,
    peak_download_bps,
    peak_upload_bps,
    raw_sample_count,
    history_dropped_count,
    history_truncated_at,
    updated_at
  FROM task_inspector_activity
  WHERE motrix_id = ?
`

const READ_HISTORY_SQL = `
  SELECT
    event_id,
    event_ordinal,
    event_key,
    kind,
    from_status,
    to_status,
    occurred_at,
    accuracy,
    error_code,
    error_message,
    error_detail_key,
    error_detail_params
  FROM task_history_events
  WHERE motrix_id = ?
  ORDER BY event_ordinal
  LIMIT ${MAX_TASK_HISTORY_EVENTS}
`

const READ_SAMPLES_SQL = `
  SELECT sampled_at, download_bps, upload_bps, flags
  FROM task_transfer_samples
  WHERE motrix_id = ?
  ORDER BY sampled_at
`

function nonNegativeBigIntFromSql(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new RangeError(`${label} must be a non-negative SQLite integer`)
  }
  return value
}

function minimumTimestamp(
  current: number | null,
  candidate: number | undefined
): number | null {
  if (candidate === undefined) return current
  return current === null ? candidate : Math.min(current, candidate)
}

function serializeDetailParams(
  value: Record<string, string> | null
): string | null {
  return value === null ? null : JSON.stringify(value)
}

function averageSpeed(bytes: bigint, activeMs: number): number {
  if (activeMs === 0) return 0
  const average = (bytes * 1_000n) / BigInt(activeMs)
  return average > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(average)
}

/**
 * Task-owned Inspector Activity persistence.
 *
 * The store never creates schema objects. Callers must run the versioned
 * session migration before constructing it.
 */
export class TaskInspectorActivityStore {
  private readonly statements = new Map<string, Database.Statement>()
  private batchTransaction?: (
    inputs: readonly PreparedCheckpoint[]
  ) => readonly TaskActivityRevision[]
  private singleCheckpointTransaction?: (
    input: PreparedCheckpoint
  ) => TaskActivityRevision
  private transitionTransaction?: (
    input: TaskHistoryEventInput
  ) => TaskActivityRevision | null
  private snapshotTransaction?: (
    taskId: string
  ) => TaskInspectorActivitySnapshot | null

  constructor(private readonly db: Database.Database) {}

  ensureTask(taskId: string, now: number): void {
    const normalizedTaskId = assertTaskId(taskId)
    assertPositiveSafeInteger(now, 'now')
    this.prepared(
      `INSERT INTO task_inspector_activity (
         motrix_id,
         tracking_started_at,
         updated_at
       ) VALUES (?, ?, ?)
       ON CONFLICT(motrix_id) DO NOTHING`
    ).run(normalizedTaskId, BigInt(now), BigInt(now))
  }

  checkpointBatch(
    inputs: readonly TaskActivityCheckpoint[]
  ): TaskActivityCheckpointResult {
    const preparedInputs = inputs.map((input) => this.prepareCheckpoint(input))
    if (preparedInputs.length === 0) {
      return { revisions: [], omissions: [] }
    }

    this.batchTransaction ??= this.db.transaction(
      (batch: readonly PreparedCheckpoint[]) =>
        batch.map((input) => this.applyCheckpoint(input))
    )
    try {
      return {
        revisions: this.batchTransaction(preparedInputs),
        omissions: [],
      }
    } catch {
      this.singleCheckpointTransaction ??= this.db.transaction(
        (input: PreparedCheckpoint) => this.applyCheckpoint(input)
      )
      const committed: TaskActivityRevision[] = []
      const omissions: TaskActivityCheckpointResult['omissions'][number][] = []
      for (const input of preparedInputs) {
        try {
          committed.push(this.singleCheckpointTransaction(input))
        } catch (error) {
          omissions.push({ taskId: input.taskId, error })
          // The service retains a failed task's pending deltas. A poison task
          // must not roll back or suppress unrelated tasks in this batch.
        }
      }
      return { revisions: committed, omissions }
    }
  }

  recordTransition(input: TaskHistoryEventInput): TaskActivityRevision | null {
    validateHistoryEventInput(input)
    const normalizedInput = {
      ...input,
      taskId: assertTaskId(input.taskId),
    }
    this.transitionTransaction ??= this.db.transaction(
      (event: TaskHistoryEventInput) => this.applyTransition(event)
    )
    return this.transitionTransaction(normalizedInput)
  }

  snapshot(taskId: string): TaskInspectorActivitySnapshot | null {
    const normalizedTaskId = assertTaskId(taskId)
    this.snapshotTransaction ??= this.db.transaction(
      (id: string): TaskInspectorActivitySnapshot | null => {
        const parent = this.prepared(
          'SELECT 1 FROM tasks WHERE motrix_id = ?'
        ).get(id)
        if (!parent) return null

        const summary = this.readSummary(id)
        if (!summary) return null
        const events = (
          this.prepared(READ_HISTORY_SQL).safeIntegers().all(id) as HistoryRow[]
        ).map((row) => this.historyEventFromRow(row))
        const points = (
          this.prepared(READ_SAMPLES_SQL).safeIntegers().all(id) as SampleRow[]
        ).map((row) => this.sampleFromRow(row))

        return {
          taskId: id,
          revision: summary.revision,
          summary: {
            trackingStartedAt: summary.trackingStartedAt,
            coverageGapAt: summary.coverageGapAt,
            revision: summary.revision,
            lastEventOrdinal: summary.lastEventOrdinal,
            activeMs: summary.activeMs,
            downloadActiveMs: summary.downloadActiveMs,
            estimatedDownloadBytes: summary.estimatedDownloadBytes.toString(),
            estimatedUploadBytes: summary.estimatedUploadBytes.toString(),
            peakDownloadBps: summary.peakDownloadBps,
            peakUploadBps: summary.peakUploadBps,
            rawSampleCount: summary.rawSampleCount,
            historyDroppedCount: summary.historyDroppedCount,
            historyTruncatedAt: summary.historyTruncatedAt,
            updatedAt: summary.updatedAt,
          },
          timeline: {
            events,
            trackingStartedAt: summary.trackingStartedAt,
            coverageGapAt: summary.coverageGapAt,
            historyDroppedCount: summary.historyDroppedCount,
            historyTruncatedAt: summary.historyTruncatedAt,
          },
          lifetime: {
            points,
            averageDownloadSpeed: averageSpeed(
              summary.estimatedDownloadBytes,
              summary.downloadActiveMs
            ),
            peakDownloadSpeed: summary.peakDownloadBps,
            peakUploadSpeed: summary.peakUploadBps,
            activeMs: summary.activeMs,
            updatedAt: summary.updatedAt,
            accuracy: 'estimated',
          },
        }
      }
    )
    return this.snapshotTransaction(normalizedTaskId)
  }

  private prepareCheckpoint(input: TaskActivityCheckpoint): PreparedCheckpoint {
    return validateCheckpoint(input)
  }

  private applyCheckpoint(input: PreparedCheckpoint): TaskActivityRevision {
    const summary = this.readSummary(input.taskId)
    if (!summary) {
      throw new Error(
        `Task Inspector Activity summary is missing: ${input.taskId}`
      )
    }

    const activeMs = saturatingAddSafeInteger(
      summary.activeMs,
      input.activeMsDelta
    )
    const downloadActiveMs = saturatingAddSafeInteger(
      summary.downloadActiveMs,
      input.downloadActiveMsDelta
    )
    const estimatedDownloadBytes = saturatingAddSignedInt64(
      summary.estimatedDownloadBytes,
      input.estimatedDownloadBytesDelta
    )
    const estimatedUploadBytes = saturatingAddSignedInt64(
      summary.estimatedUploadBytes,
      input.estimatedUploadBytesDelta
    )
    const rawSampleCount = saturatingAddSafeInteger(
      summary.rawSampleCount,
      input.rawSampleCountDelta
    )
    const revision = saturatingAddSafeInteger(summary.revision, 1)
    if (revision.saturated) {
      throw new RangeError('Task Inspector Activity revision is exhausted')
    }

    const saturated =
      activeMs.saturated ||
      downloadActiveMs.saturated ||
      estimatedDownloadBytes.saturated ||
      estimatedUploadBytes.saturated ||
      rawSampleCount.saturated
    const coverageGapAt = minimumTimestamp(
      summary.coverageGapAt,
      saturated
        ? Math.min(input.coverageGapAt ?? input.updatedAt, input.updatedAt)
        : input.coverageGapAt
    )

    for (const sample of input.samples) {
      this.prepared(
        `INSERT INTO task_transfer_samples (
           motrix_id,
           sampled_at,
           download_bps,
           upload_bps,
           flags
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(motrix_id, sampled_at) DO UPDATE SET
           download_bps = excluded.download_bps,
           upload_bps = excluded.upload_bps,
           flags = task_transfer_samples.flags | excluded.flags`
      ).run(
        input.taskId,
        BigInt(sample.t),
        BigInt(sample.down),
        BigInt(sample.up),
        BigInt(sample.flags)
      )
    }

    const sampleCountRow = this.prepared(
      `SELECT COUNT(*) AS count
       FROM task_transfer_samples
       WHERE motrix_id = ?`
    )
      .safeIntegers()
      .get(input.taskId) as { count: bigint }
    const sampleCount = nonNegativeIntegerFromBigInt(
      sampleCountRow.count,
      'sample count'
    )
    if (sampleCount > MAX_PERSISTED_TASK_SAMPLES) {
      const allSamples = (
        this.prepared(READ_SAMPLES_SQL)
          .safeIntegers()
          .all(input.taskId) as SampleRow[]
      ).map((row) => this.sampleFromRow(row))
      const compacted = compactTaskTransferSamples(allSamples)
      if (compacted.length !== COMPACTED_TASK_SAMPLE_COUNT) {
        throw new Error('Task sample compaction returned an invalid size')
      }
      this.prepared(
        'DELETE FROM task_transfer_samples WHERE motrix_id = ?'
      ).run(input.taskId)
      for (const sample of compacted) {
        this.prepared(
          `INSERT INTO task_transfer_samples (
             motrix_id,
             sampled_at,
             download_bps,
             upload_bps,
             flags
           ) VALUES (?, ?, ?, ?, ?)`
        ).run(
          input.taskId,
          BigInt(sample.t),
          BigInt(sample.down),
          BigInt(sample.up),
          BigInt(sample.flags)
        )
      }
    }

    const updated = this.prepared(
      `UPDATE task_inspector_activity
       SET
         coverage_gap_at = ?,
         revision = ?,
         active_ms = ?,
         download_active_ms = ?,
         estimated_download_bytes = ?,
         estimated_upload_bytes = ?,
         peak_download_bps = ?,
         peak_upload_bps = ?,
         raw_sample_count = ?,
         updated_at = ?
       WHERE motrix_id = ?`
    ).run(
      coverageGapAt === null ? null : BigInt(coverageGapAt),
      BigInt(revision.value),
      BigInt(activeMs.value),
      BigInt(downloadActiveMs.value),
      estimatedDownloadBytes.value,
      estimatedUploadBytes.value,
      BigInt(Math.max(summary.peakDownloadBps, input.peakDownloadBps)),
      BigInt(Math.max(summary.peakUploadBps, input.peakUploadBps)),
      BigInt(rawSampleCount.value),
      BigInt(input.updatedAt),
      input.taskId
    )
    if (updated.changes !== 1) {
      throw new Error(
        `Task Inspector Activity summary disappeared: ${input.taskId}`
      )
    }

    return {
      taskId: input.taskId,
      revision: revision.value,
      reason:
        saturated || input.coverageGapAt !== undefined
          ? TaskInspectorActivityUpdateReason.CoverageDegraded
          : TaskInspectorActivityUpdateReason.Checkpoint,
    }
  }

  private applyTransition(
    input: TaskHistoryEventInput
  ): TaskActivityRevision | null {
    const summary = this.readSummary(input.taskId)
    if (!summary) {
      throw new Error(
        `Task Inspector Activity summary is missing: ${input.taskId}`
      )
    }

    const byOrdinal = this.prepared(
      `SELECT event_ordinal, event_key
       FROM task_history_events
       WHERE motrix_id = ? AND event_ordinal = ?`
    ).get(input.taskId, BigInt(input.eventOrdinal)) as
      | { event_ordinal: number | bigint; event_key: string }
      | undefined
    const byKey = this.prepared(
      `SELECT event_ordinal, event_key
       FROM task_history_events
       WHERE motrix_id = ? AND event_key = ?`
    ).get(input.taskId, input.eventKey) as
      | { event_ordinal: number | bigint; event_key: string }
      | undefined
    if (byOrdinal || byKey) {
      const ordinalMatches =
        byOrdinal !== undefined &&
        safeIntegerFromSql(byOrdinal.event_ordinal, 'event_ordinal') ===
          input.eventOrdinal &&
        byOrdinal.event_key === input.eventKey
      const keyMatches =
        byKey !== undefined &&
        safeIntegerFromSql(byKey.event_ordinal, 'event_ordinal') ===
          input.eventOrdinal &&
        byKey.event_key === input.eventKey
      if (ordinalMatches && keyMatches) return null
      throw new Error('Task history event ordinal/key conflict')
    }

    if (input.eventOrdinal <= summary.lastEventOrdinal) {
      return null
    }
    if (input.eventOrdinal !== summary.lastEventOrdinal + 1) {
      throw new Error(
        `Task history ordinal gap: expected ${summary.lastEventOrdinal + 1}, ` +
          `received ${input.eventOrdinal}`
      )
    }

    this.prepared(
      `INSERT INTO task_history_events (
         motrix_id,
         event_ordinal,
         event_key,
         kind,
         from_status,
         to_status,
         occurred_at,
         accuracy,
         error_code,
         error_message,
         error_detail_key,
         error_detail_params
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.taskId,
      BigInt(input.eventOrdinal),
      input.eventKey,
      input.kind,
      input.fromStatus,
      input.toStatus,
      BigInt(input.occurredAt),
      input.accuracy,
      input.errorCode,
      input.errorMessage,
      input.errorDetailKey,
      serializeDetailParams(input.errorDetailParams)
    )

    const retainedRows = this.readAllHistoryRows(input.taskId)
    const droppedRows =
      retainedRows.length > MAX_TASK_HISTORY_EVENTS
        ? this.pruneHistory(input.taskId, retainedRows)
        : []
    const revision = saturatingAddSafeInteger(summary.revision, 1)
    if (revision.saturated) {
      throw new RangeError('Task Inspector Activity revision is exhausted')
    }
    const droppedCount = saturatingAddSafeInteger(
      summary.historyDroppedCount,
      droppedRows.length
    )
    const earliestDroppedAt =
      droppedRows.length === 0
        ? undefined
        : Math.min(
            ...droppedRows.map((row) =>
              safeIntegerFromSql(row.occurred_at, 'occurred_at')
            )
          )
    const historyTruncatedAt = minimumTimestamp(
      summary.historyTruncatedAt,
      earliestDroppedAt
    )

    const updated = this.prepared(
      `UPDATE task_inspector_activity
       SET
         revision = ?,
         last_event_ordinal = ?,
         history_dropped_count = ?,
         history_truncated_at = ?,
         updated_at = ?
       WHERE motrix_id = ?`
    ).run(
      BigInt(revision.value),
      BigInt(input.eventOrdinal),
      BigInt(droppedCount.value),
      historyTruncatedAt === null ? null : BigInt(historyTruncatedAt),
      BigInt(input.occurredAt),
      input.taskId
    )
    if (updated.changes !== 1) {
      throw new Error(
        `Task Inspector Activity summary disappeared: ${input.taskId}`
      )
    }

    return {
      taskId: input.taskId,
      revision: revision.value,
      reason: TaskInspectorActivityUpdateReason.Transition,
    }
  }

  private pruneHistory(
    taskId: string,
    rows: readonly HistoryRow[]
  ): HistoryRow[] {
    const added = rows
      .filter((row) => row.kind === TaskHistoryEventKind.Added)
      .sort(
        (left, right) =>
          safeIntegerFromSql(left.event_ordinal, 'event_ordinal') -
          safeIntegerFromSql(right.event_ordinal, 'event_ordinal')
      )[0]
    const descending = [...rows].sort(
      (left, right) =>
        safeIntegerFromSql(right.event_ordinal, 'event_ordinal') -
        safeIntegerFromSql(left.event_ordinal, 'event_ordinal')
    )
    const keep = new Set<bigint>()
    if (added) {
      keep.add(added.event_id)
      for (const row of descending) {
        if (row.event_id === added.event_id) continue
        if (keep.size >= MAX_TASK_HISTORY_EVENTS) break
        keep.add(row.event_id)
      }
    } else {
      for (const row of descending.slice(0, MAX_TASK_HISTORY_EVENTS)) {
        keep.add(row.event_id)
      }
    }

    const dropped = rows.filter((row) => !keep.has(row.event_id))
    for (const row of dropped) {
      this.prepared(
        `DELETE FROM task_history_events
         WHERE motrix_id = ? AND event_id = ?`
      ).run(taskId, row.event_id)
    }
    return dropped
  }

  private readAllHistoryRows(taskId: string): HistoryRow[] {
    return this.prepared(
      `SELECT
         event_id,
         event_ordinal,
         event_key,
         kind,
         from_status,
         to_status,
         occurred_at,
         accuracy,
         error_code,
         error_message,
         error_detail_key,
         error_detail_params
       FROM task_history_events
       WHERE motrix_id = ?
       ORDER BY event_ordinal`
    )
      .safeIntegers()
      .all(taskId) as HistoryRow[]
  }

  private historyEventFromRow(row: HistoryRow): TaskHistoryEvent {
    return {
      eventOrdinal: safeIntegerFromSql(row.event_ordinal, 'event_ordinal'),
      eventKey: row.event_key,
      kind: row.kind,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      occurredAt: safeIntegerFromSql(row.occurred_at, 'occurred_at'),
      accuracy: row.accuracy,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      errorDetailKey: row.error_detail_key,
      errorDetailParams: parseDetailParams(row.error_detail_params),
    }
  }

  private sampleFromRow(row: SampleRow): TaskTransferSample {
    return {
      t: safeIntegerFromSql(row.sampled_at, 'sampled_at'),
      down: nonNegativeIntegerFromBigInt(row.download_bps, 'download_bps'),
      up: nonNegativeIntegerFromBigInt(row.upload_bps, 'upload_bps'),
      flags: nonNegativeIntegerFromBigInt(row.flags, 'flags'),
    }
  }

  private readSummary(taskId: string): Summary | null {
    const row = this.prepared(READ_SUMMARY_SQL).safeIntegers().get(taskId) as
      | SummaryRow
      | undefined
    if (!row) return null
    return {
      taskId: row.motrix_id,
      trackingStartedAt: safeIntegerFromSql(
        row.tracking_started_at,
        'tracking_started_at'
      ),
      coverageGapAt:
        row.coverage_gap_at === null
          ? null
          : safeIntegerFromSql(row.coverage_gap_at, 'coverage_gap_at'),
      revision: nonNegativeIntegerFromBigInt(row.revision, 'revision'),
      lastEventOrdinal: nonNegativeIntegerFromBigInt(
        row.last_event_ordinal,
        'last_event_ordinal'
      ),
      activeMs: nonNegativeIntegerFromBigInt(row.active_ms, 'active_ms'),
      downloadActiveMs: nonNegativeIntegerFromBigInt(
        row.download_active_ms,
        'download_active_ms'
      ),
      estimatedDownloadBytes: nonNegativeBigIntFromSql(
        row.estimated_download_bytes,
        'estimated_download_bytes'
      ),
      estimatedUploadBytes: nonNegativeBigIntFromSql(
        row.estimated_upload_bytes,
        'estimated_upload_bytes'
      ),
      peakDownloadBps: nonNegativeIntegerFromBigInt(
        row.peak_download_bps,
        'peak_download_bps'
      ),
      peakUploadBps: nonNegativeIntegerFromBigInt(
        row.peak_upload_bps,
        'peak_upload_bps'
      ),
      rawSampleCount: nonNegativeIntegerFromBigInt(
        row.raw_sample_count,
        'raw_sample_count'
      ),
      historyDroppedCount: nonNegativeIntegerFromBigInt(
        row.history_dropped_count,
        'history_dropped_count'
      ),
      historyTruncatedAt:
        row.history_truncated_at === null
          ? null
          : safeIntegerFromSql(
              row.history_truncated_at,
              'history_truncated_at'
            ),
      updatedAt: safeIntegerFromSql(row.updated_at, 'updated_at'),
    }
  }

  private prepared(sql: string): Database.Statement {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }
}
