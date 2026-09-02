import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { getLogger } from '@core/logger'
import { ensureMetadataSchema } from '@core/plugin/capabilities/metadata'
import type { StagedMetadataOp } from '@core/plugin/hooks/staged-effects'
import {
  admitPostDeliveries,
  type PostDeliveryAdmissionSummary,
} from '@core/plugin/post/delivery-retention'
import {
  DEFAULT_POST_DELIVERY_QUOTA_CONFIG,
  type PostDeliveryAdmission,
  type PostDeliveryQuotaConfig,
} from '@core/plugin/post/delivery-types'
import { DownloadErrorCode } from '@shared/errors'
import {
  type TaskErrorFields,
  taskErrorFieldsEqual,
} from '@shared/task-error/descriptor'
import { parseDetailParams } from '@shared/task-error/detail-params'
import type {
  AppNotification,
  NotificationSeverity,
} from '@shared/types/notification'
import type { SourceMeta, TaskSource } from '@shared/types/task'
import {
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import type {
  TaskDiagnosisOccurrence,
  TaskOccurrence,
} from '@shared/types/task-occurrence'
import type BetterSqlite3 from 'better-sqlite3'
import Database from 'better-sqlite3'
import { z } from 'zod'
import { migrate } from './migrations'
import { SqlitePostDeliveryRepository } from './post-delivery-repository'

const log = getLogger('MotrixDatabase')

/**
 * Internal-only sentinel thrown INSIDE `insertNotificationWithLedger`'s
 * transaction to force a rollback (of the ledger insert too) when the
 * display insert must be treated as stale rather than as a genuine error.
 * Caught immediately outside the transaction and converted to a `null`
 * return — never escapes this file. See the two call sites (F3's UNIQUE
 * backstop, F6's post-prune survival check) for the two narrow cases this
 * covers.
 */
class NotificationInsertStaleError extends Error {}

const TASK_ERROR_FIELDS_SCHEMA = z.object({
  errorCode: z.enum(DownloadErrorCode).nullable(),
  errorMessage: z.string().nullable(),
  errorDetailKey: z.string().nullable(),
  errorDetailParams: z.record(z.string(), z.string()).nullable(),
})

const TASK_TERMINAL_OCCURRENCE_SCHEMA = z.object({
  occurrenceId: z.string(),
  type: z.literal('terminal'),
  taskId: z.string(),
  fromStatus: z.enum(TaskStatus),
  toStatus: z.union([
    z.literal(TaskStatus.Completed),
    z.literal(TaskStatus.Error),
  ]),
  cause: z.enum(['engine', 'finalize', 'media', 'recovery', 'user-cancel']),
  errorGroup: TASK_ERROR_FIELDS_SCHEMA.nullable(),
  createdAt: z.number(),
})

const TASK_DIAGNOSIS_OCCURRENCE_SCHEMA = z.object({
  occurrenceId: z.string(),
  type: z.literal('diagnosis'),
  taskId: z.string(),
  terminalOccurrenceId: z.string(),
  revision: z.number(),
  diagnosis: TASK_ERROR_FIELDS_SCHEMA,
  createdAt: z.number(),
})

/** Validates a `task_occurrences.payload` JSON blob back into a
 *  `TaskOccurrence` on read — guards against a corrupted or otherwise
 *  unreadable row rather than trusting our own past writes forever. */
const TASK_OCCURRENCE_SCHEMA = z.union([
  TASK_TERMINAL_OCCURRENCE_SCHEMA,
  TASK_DIAGNOSIS_OCCURRENCE_SCHEMA,
])

/** Validates a `notifications.title_params`/`body_params` JSON blob on
 *  read — a corrupted or hand-edited column reads back as `null` rather
 *  than throwing or trusting an unreadable value. */
const NOTIFICATION_PARAMS_SCHEMA = z.record(z.string(), z.string())

/** Input to `insertNotificationWithLedger`. `sourceKey` is the
 *  ledger-dedup key; `taskId` binds the notification's lifecycle to a
 *  task (`null` for engine/ad-hoc notifications not tied to any task). */
export interface NewNotificationInput {
  sourceKey: string
  taskId: string | null
  kind: string
  severity: NotificationSeverity
  titleKey: string
  titleParams: Record<string, string> | null
  bodyKey: string | null
  bodyParams: Record<string, string> | null
  createdAt: number
}

/** Maximum number of display rows (`notifications`) retained; the oldest
 *  rows are pruned inside the same transaction as each insert. The ledger
 *  (`notification_occurrences`) is never capped — it must-reach forever. */
export const NOTIFICATION_DISPLAY_CAP = 500

/** Default row count for `listNotifications`. */
export const NOTIFICATION_LIST_LIMIT = 100

/** Task-level row from the tasks table — user-facing identity + aggregate
 *  status. Does NOT carry any engine GID or per-instance progress; those
 *  live in TaskInstanceRow. */
export interface TaskRow {
  motrixId: string
  name: string
  kind: TaskKind
  taskType: TaskType
  category: string | null
  priority: number
  tags: string | null
  createdAt: number
  updatedAt: number
  finalPath: string
  finalName: string
  torrentMetaPath: string | null
  infoHash: string | null
  totalBytes: number
  downloadedBytes: number
  sizeWhenDone: number
  fileCount: number
  isPrivate: boolean
  trackers: string[][]
  pieceLength: number
  aggStatus: TaskStatus
  finishedAt: number | null
  errorMessage: string | null
  errorCode: DownloadErrorCode | null
  errorDetailKey: string | null
  errorDetailParams: Record<string, string> | null
  diagnosisRevision: number
  uploadedBytesBaseline: number
  source: TaskSource
  sourceMeta: SourceMeta
}

/** Engine-level row from the task_instances table — one per engine GID,
 *  or per non-aria2 execution step (e.g. ffmpeg mux). A task has one
 *  TaskInstanceRow for single-instance kinds (direct/bt) and N+ for
 *  multi-instance kinds (hls, magnet metadata pending, mux). */
export interface TaskInstanceRow {
  instanceId: string
  motrixId: string
  gid: string | null
  phase: TaskInstancePhase
  status: TaskStatus
  progress: number
  totalBytes: number
  downloadedBytes: number
  uploadedBytes: number
  diskPath: string
  transitionPhase: TransitionPhase
  uris: string[]
  uriHash: string | null
  payload: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

/** A task with all its instances eagerly loaded — what SessionManager.restore
 *  consumes when rebuilding DownloadTask domain objects. */
export interface TaskWithInstances {
  task: TaskRow
  instances: TaskInstanceRow[]
}

export interface TaskFileRow {
  fileIndex: number
  path: string
  size: number
  selected: boolean
}

export interface TaskWithInstancesAndFiles extends TaskWithInstances {
  files: TaskFileRow[]
}

/** Result of a CAS-guarded diagnosis upgrade — see
 *  `MotrixDatabase.applyDiagnosisUpgradeRow`. */
export type DiagnosisUpgradeRowOutcome = 'updated' | 'unchanged' | 'conflict'

export interface TerminalHookFinalizeJournalUpdate {
  journalId: string
  taskId: string
  targetIdentity: unknown
  updatedAt: number
}

/**
 * Complete durable graph for one terminal Hook boundary. Candidate rows are
 * already snapshotted and DTO-validated under the registry generation lease.
 */
export interface TerminalHookCommitInput {
  payload: TaskWithInstances
  files?: readonly TaskFileRow[]
  occurrence: TaskOccurrence | null
  fileRebase?: { sourceRoot: string; targetRoot: string }
  metadataOps?: readonly StagedMetadataOp[]
  finalizeJournal?: TerminalHookFinalizeJournalUpdate
  postDeliveries?: readonly PostDeliveryAdmission[]
  postQuota?: PostDeliveryQuotaConfig
  /** Synchronous registry-generation revalidation at the write boundary. */
  beforeCommit?: () => void
}

export class MotrixDatabase {
  private db: BetterSqlite3.Database
  // Content signature (task + instances) of the last row this process wrote
  // per motrixId. saveTasksBatch skips re-writing a row whose signature is
  // unchanged — the periodic save rewrites the whole task list (incl. the
  // immutable completed history) every active tick, and re-running upsert +
  // delete/reinsert for unchanged rows is pure WAL/disk churn. Eviction on
  // every out-of-band writer (deleteTask / replaceInstances / deleteInstance)
  // keeps it fail-safe: a stale-or-missing entry forces a write, never a skip.
  private readonly lastPersistedSig = new Map<string, string>()
  private postDeliveryRepository?: SqlitePostDeliveryRepository
  // ── task-level statements ─────────────────────────────
  private stmtUpsertTask!: BetterSqlite3.Statement
  private stmtGetAllTasks!: BetterSqlite3.Statement
  private stmtGetTask!: BetterSqlite3.Statement
  private stmtDeleteTask!: BetterSqlite3.Statement
  private stmtListBridgeTasks!: BetterSqlite3.Statement
  // ── instance-level statements ─────────────────────────
  private stmtInsertInstance!: BetterSqlite3.Statement
  private stmtDeleteInstancesForTask!: BetterSqlite3.Statement
  private stmtDeleteInstance!: BetterSqlite3.Statement
  private stmtGetInstancesForTask!: BetterSqlite3.Statement
  private stmtGetAllInstances!: BetterSqlite3.Statement
  // ── file-level statements ─────────────────────────────
  private stmtInsertFile!: BetterSqlite3.Statement
  private stmtDeleteFiles!: BetterSqlite3.Statement
  private stmtGetFiles!: BetterSqlite3.Statement
  // ── occurrence-outbox statements ──────────────────────
  private stmtInsertOccurrenceOrIgnore!: BetterSqlite3.Statement
  private stmtListUndispatchedOccurrences!: BetterSqlite3.Statement
  private stmtMarkOccurrenceDispatched!: BetterSqlite3.Statement
  private stmtDeleteTaskOccurrences!: BetterSqlite3.Statement
  private stmtReadDiagnosisGroup!: BetterSqlite3.Statement
  private stmtApplyDiagnosisUpgrade!: BetterSqlite3.Statement
  // ── notification statements ───────────────────────────
  private stmtInsertNotificationOccurrenceOrIgnore!: BetterSqlite3.Statement
  private stmtInsertNotification!: BetterSqlite3.Statement
  private stmtPruneNotifications!: BetterSqlite3.Statement
  private stmtNotificationExistsById!: BetterSqlite3.Statement
  private stmtListNotifications!: BetterSqlite3.Statement
  private stmtGetUnreadNotificationCount!: BetterSqlite3.Statement
  private stmtMarkNotificationRead!: BetterSqlite3.Statement
  private stmtMarkAllNotificationsRead!: BetterSqlite3.Statement
  private stmtDeleteNotification!: BetterSqlite3.Statement
  private stmtClearNotifications!: BetterSqlite3.Statement
  private stmtUpdateNotificationBySourceKey!: BetterSqlite3.Statement
  private stmtDeleteEngineNotificationLedgerBefore!: BetterSqlite3.Statement
  private stmtDeleteNotificationLedgerForTask!: BetterSqlite3.Statement

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.db.pragma('wal_autocheckpoint = 1000')
  }

  get database(): BetterSqlite3.Database {
    return this.db
  }

  init(): void {
    migrate(this.db)
    ensureMetadataSchema(this.db)
    this.prepareStatements()
    this.postDeliveryRepository = new SqlitePostDeliveryRepository(this.db)
  }

  get durablePostDeliveries(): SqlitePostDeliveryRepository {
    if (!this.postDeliveryRepository) {
      throw new Error(
        'MotrixDatabase.init() must run before plugin delivery access'
      )
    }
    return this.postDeliveryRepository
  }

  private prepareStatements(): void {
    const TASK_COLS = `
      motrix_id, name, kind, task_type, category, priority, tags,
      created_at, updated_at,
      final_path, final_name, torrent_meta_path,
      info_hash, total_bytes, downloaded_bytes, size_when_done, file_count,
      is_private, trackers, piece_length,
      agg_status, finished_at, error_message, error_code,
      error_detail_key, error_detail_params, diagnosis_revision,
      uploaded_bytes_baseline, source, source_meta
    `
    const INSTANCE_COLS = `
      instance_id, motrix_id, gid, phase, status,
      progress, total_bytes, downloaded_bytes, uploaded_bytes,
      disk_path, transition_phase, uris, uri_hash, payload,
      created_at, updated_at
    `

    this.stmtUpsertTask = this.db.prepare(`
      INSERT INTO tasks (
        motrix_id, name, kind, task_type, category, priority, tags,
        created_at, updated_at,
        final_path, final_name, torrent_meta_path,
        info_hash, total_bytes, downloaded_bytes, size_when_done, file_count,
        is_private, trackers, piece_length,
        agg_status, finished_at, error_message, error_code,
        error_detail_key, error_detail_params, diagnosis_revision,
        uploaded_bytes_baseline, source, source_meta
      ) VALUES (
        @motrixId, @name, @kind, @taskType, @category, @priority, @tags,
        @createdAt, @updatedAt,
        @finalPath, @finalName, @torrentMetaPath,
        @infoHash, @totalBytes, @downloadedBytes, @sizeWhenDone, @fileCount,
        @isPrivate, @trackers, @pieceLength,
        @aggStatus, @finishedAt, @errorMessage, @errorCode,
        @errorDetailKey, @errorDetailParams, @diagnosisRevision,
        @uploadedBytesBaseline, @source, @sourceMeta
      )
      ON CONFLICT(motrix_id) DO UPDATE SET
        name = @name,
        kind = @kind,
        task_type = @taskType,
        category = @category,
        priority = @priority,
        tags = @tags,
        updated_at = @updatedAt,
        final_path = @finalPath,
        final_name = @finalName,
        torrent_meta_path = @torrentMetaPath,
        info_hash = @infoHash,
        total_bytes = @totalBytes,
        downloaded_bytes = @downloadedBytes,
        size_when_done = @sizeWhenDone,
        file_count = @fileCount,
        is_private = @isPrivate,
        trackers = @trackers,
        piece_length = @pieceLength,
        agg_status = @aggStatus,
        finished_at = @finishedAt,
        error_message = @errorMessage,
        error_code = @errorCode,
        error_detail_key = @errorDetailKey,
        error_detail_params = @errorDetailParams,
        diagnosis_revision = @diagnosisRevision,
        uploaded_bytes_baseline = @uploadedBytesBaseline,
        source = @source,
        source_meta = @sourceMeta
    `)

    this.stmtGetAllTasks = this.db.prepare(
      `SELECT ${TASK_COLS} FROM tasks ORDER BY created_at DESC`
    )
    this.stmtGetTask = this.db.prepare(
      `SELECT ${TASK_COLS} FROM tasks WHERE motrix_id = ?`
    )
    this.stmtDeleteTask = this.db.prepare(
      'DELETE FROM tasks WHERE motrix_id = ?'
    )
    this.stmtListBridgeTasks = this.db.prepare(
      `SELECT ${TASK_COLS}
       FROM tasks
       WHERE source = 'bridge'
         AND agg_status IN ('queued', 'downloading', 'paused')`
    )

    this.stmtInsertInstance = this.db.prepare(`
      INSERT INTO task_instances (
        instance_id, motrix_id, gid, phase, status,
        progress, total_bytes, downloaded_bytes, uploaded_bytes,
        disk_path, transition_phase, uris, uri_hash, payload,
        created_at, updated_at
      ) VALUES (
        @instanceId, @motrixId, @gid, @phase, @status,
        @progress, @totalBytes, @downloadedBytes, @uploadedBytes,
        @diskPath, @transitionPhase, @uris, @uriHash, @payload,
        @createdAt, @updatedAt
      )
    `)
    this.stmtDeleteInstancesForTask = this.db.prepare(
      'DELETE FROM task_instances WHERE motrix_id = ?'
    )
    this.stmtDeleteInstance = this.db.prepare(
      'DELETE FROM task_instances WHERE instance_id = ?'
    )
    this.stmtGetInstancesForTask = this.db.prepare(
      `SELECT ${INSTANCE_COLS} FROM task_instances WHERE motrix_id = ? ORDER BY created_at ASC`
    )
    this.stmtGetAllInstances = this.db.prepare(
      `SELECT ${INSTANCE_COLS} FROM task_instances ORDER BY motrix_id, created_at ASC`
    )

    this.stmtDeleteFiles = this.db.prepare(
      'DELETE FROM task_files WHERE motrix_id = ?'
    )
    this.stmtInsertFile = this.db.prepare(
      'INSERT INTO task_files (motrix_id, file_index, path, size, selected) VALUES (?, ?, ?, ?, ?)'
    )
    this.stmtGetFiles = this.db.prepare(
      'SELECT file_index, path, size, selected FROM task_files WHERE motrix_id = ? ORDER BY file_index ASC'
    )

    this.stmtInsertOccurrenceOrIgnore = this.db.prepare(`
      INSERT OR IGNORE INTO task_occurrences (
        occurrence_id, type, task_id, from_status, to_status, cause,
        revision, payload, created_at, dispatched_at
      ) VALUES (
        @occurrenceId, @type, @taskId, @fromStatus, @toStatus, @cause,
        @revision, @payload, @createdAt, NULL
      )
    `)
    this.stmtListUndispatchedOccurrences = this.db.prepare(
      `SELECT occurrence_id, payload FROM task_occurrences
       WHERE dispatched_at IS NULL
       ORDER BY created_at ASC`
    )
    this.stmtMarkOccurrenceDispatched = this.db.prepare(
      'UPDATE task_occurrences SET dispatched_at = ? WHERE occurrence_id = ?'
    )
    this.stmtDeleteTaskOccurrences = this.db.prepare(
      'DELETE FROM task_occurrences WHERE task_id = ?'
    )

    this.stmtInsertNotificationOccurrenceOrIgnore = this.db.prepare(
      'INSERT OR IGNORE INTO notification_occurrences (source_key, task_id, created_at) VALUES (?, ?, ?)'
    )
    this.stmtInsertNotification = this.db.prepare(`
      INSERT INTO notifications (
        id, source_key, kind, severity, title_key, title_params,
        body_key, body_params, task_id, created_at, read_at
      ) VALUES (
        @id, @sourceKey, @kind, @severity, @titleKey, @titleParams,
        @bodyKey, @bodyParams, @taskId, @createdAt, NULL
      )
    `)
    // Cap prune runs inside the same transaction as the insert, so a
    // display row is never visible even momentarily beyond the cap.
    // NOTIFICATION_DISPLAY_CAP is a compile-time constant, not user
    // input, so interpolating it into the prepared SQL is safe.
    // F6: `, rowid DESC` breaks ties deterministically when two-or-more
    // rows share the same `created_at` millisecond (or, under a
    // clock-rollback, when a freshly-inserted row is NOT the newest by
    // timestamp) — insertion order (rowid) is the tiebreaker, matching
    // `stmtListNotifications` below.
    this.stmtPruneNotifications = this.db.prepare(`
      DELETE FROM notifications WHERE id IN (
        SELECT id FROM notifications
        ORDER BY created_at DESC, rowid DESC
        LIMIT -1 OFFSET ${NOTIFICATION_DISPLAY_CAP}
      )
    `)
    // F6: used right after the prune inside `insertNotificationWithLedger`
    // to detect a clock-rollback insert that sorted behind the cap window
    // and got pruned by the very statement above, in the same transaction.
    this.stmtNotificationExistsById = this.db.prepare(
      'SELECT 1 FROM notifications WHERE id = ?'
    )
    this.stmtListNotifications = this.db.prepare(
      `SELECT id, source_key, kind, severity, title_key, title_params,
              body_key, body_params, task_id, created_at, read_at
       FROM notifications
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`
    )
    this.stmtGetUnreadNotificationCount = this.db.prepare(
      'SELECT COUNT(*) AS c FROM notifications WHERE read_at IS NULL'
    )
    this.stmtMarkNotificationRead = this.db.prepare(
      'UPDATE notifications SET read_at = ? WHERE id = ?'
    )
    this.stmtMarkAllNotificationsRead = this.db.prepare(
      'UPDATE notifications SET read_at = ? WHERE read_at IS NULL'
    )
    this.stmtDeleteNotification = this.db.prepare(
      'DELETE FROM notifications WHERE id = ?'
    )
    this.stmtClearNotifications = this.db.prepare('DELETE FROM notifications')
    this.stmtUpdateNotificationBySourceKey = this.db.prepare(
      'UPDATE notifications SET body_key = ?, body_params = ? WHERE source_key = ?'
    )
    this.stmtDeleteEngineNotificationLedgerBefore = this.db.prepare(
      'DELETE FROM notification_occurrences WHERE task_id IS NULL AND created_at < ?'
    )
    this.stmtDeleteNotificationLedgerForTask = this.db.prepare(
      'DELETE FROM notification_occurrences WHERE task_id = ?'
    )

    this.stmtReadDiagnosisGroup = this.db.prepare(`
      SELECT diagnosis_revision, error_code, error_message,
             error_detail_key, error_detail_params
      FROM tasks WHERE motrix_id = ?
    `)
    this.stmtApplyDiagnosisUpgrade = this.db.prepare(`
      UPDATE tasks SET
        error_code = @errorCode,
        error_message = @errorMessage,
        error_detail_key = @errorDetailKey,
        error_detail_params = @errorDetailParams,
        diagnosis_revision = @nextRevision
      WHERE motrix_id = @motrixId AND diagnosis_revision = @expectedRevision
    `)
  }

  /** sha256 of the exact content we persist; identical content ⇒ identical
   *  signature, letting saveTasksBatch skip an unchanged row. */
  private rowSignature(row: TaskWithInstances): string {
    return createHash('sha256').update(JSON.stringify(row)).digest('hex')
  }

  /** Upsert the task row and replace its instance rows. */
  private writeRow(row: TaskWithInstances): void {
    this.stmtUpsertTask.run(this.serializeTask(row.task))
    this.stmtDeleteInstancesForTask.run(row.task.motrixId)
    for (const inst of row.instances) {
      this.stmtInsertInstance.run(this.serializeInstance(inst))
    }
  }

  private writeTaskFiles(motrixId: string, files: TaskFileRow[]): void {
    this.stmtDeleteFiles.run(motrixId)
    for (const file of files) {
      this.stmtInsertFile.run(
        motrixId,
        file.fileIndex,
        file.path,
        file.size,
        file.selected ? 1 : 0
      )
    }
  }

  saveTaskWithInstances(payload: TaskWithInstances): void {
    this.db.transaction(() => {
      this.writeRow(payload)
      this.lastPersistedSig.set(
        payload.task.motrixId,
        this.rowSignature(payload)
      )
    })()
  }

  /**
   * Persist a newly-created task graph and every metadata mutation staged by
   * beforeCreate as one SQLite commit. The task row must be written first so
   * plugin_task_metadata's task foreign key is satisfied, while any metadata
   * validation/quota failure rolls the complete create intent back.
   */
  persistTaskWithPluginMetadata(
    payload: TaskWithInstances,
    operations: readonly StagedMetadataOp[]
  ): void {
    const signature = this.rowSignature(payload)
    this.db.transaction(() => {
      this.writeRow(payload)
      this.applyStagedMetadata(
        payload.task.motrixId,
        operations,
        payload.task.updatedAt
      )
    })()
    this.lastPersistedSig.set(payload.task.motrixId, signature)
  }

  /**
   * Replace a task's complete durable graph in one SQLite transaction.
   *
   * The magnet MetadataReady -> BT swap cannot expose a new parent/instance
   * pair with stale selected-file rows (or vice versa). Keep the write-skip
   * signature update outside the transaction callback so a trigger/commit
   * failure cannot leave the in-memory cache claiming rolled-back content.
   */
  saveTaskWithInstancesAndFiles(payload: TaskWithInstancesAndFiles): void {
    const row: TaskWithInstances = {
      task: payload.task,
      instances: payload.instances,
    }
    const signature = this.rowSignature(row)
    this.db.transaction(() => {
      this.writeRow(row)
      this.writeTaskFiles(payload.task.motrixId, payload.files)
    })()
    this.lastPersistedSig.set(payload.task.motrixId, signature)
  }

  saveTasksBatch(payloads: TaskWithInstances[]): void {
    const tx = this.db.transaction((rows: TaskWithInstances[]) => {
      for (const row of rows) {
        const sig = this.rowSignature(row)
        // Skip rows whose content is byte-identical to what we last wrote —
        // the dominant case during an active save that walks the whole task
        // history. Any real change flips the signature and falls through.
        if (this.lastPersistedSig.get(row.task.motrixId) === sig) continue
        this.writeRow(row)
        this.lastPersistedSig.set(row.task.motrixId, sig)
      }
    })
    tx(payloads)
  }

  getAllTasks(): TaskWithInstances[] {
    const taskRows = this.stmtGetAllTasks.all() as RawTaskRow[]
    if (taskRows.length === 0) return []
    const allInstances = this.stmtGetAllInstances.all() as RawInstanceRow[]
    const byMotrixId = new Map<string, TaskInstanceRow[]>()
    for (const raw of allInstances) {
      const inst = mapInstanceRow(raw)
      const arr = byMotrixId.get(inst.motrixId) ?? []
      arr.push(inst)
      byMotrixId.set(inst.motrixId, arr)
    }
    return taskRows.map((raw) => {
      const task = mapTaskRow(raw)
      return {
        task,
        instances: byMotrixId.get(task.motrixId) ?? [],
      }
    })
  }

  getTask(motrixId: string): TaskWithInstances | null {
    const taskRaw = this.stmtGetTask.get(motrixId) as RawTaskRow | undefined
    if (!taskRaw) return null
    const instRaws = this.stmtGetInstancesForTask.all(
      motrixId
    ) as RawInstanceRow[]
    return {
      task: mapTaskRow(taskRaw),
      instances: instRaws.map(mapInstanceRow),
    }
  }

  listBridgeTasks(): TaskWithInstances[] {
    const taskRows = this.stmtListBridgeTasks.all() as RawTaskRow[]
    return taskRows.map((raw) => {
      const task = mapTaskRow(raw)
      const instRaws = this.stmtGetInstancesForTask.all(
        task.motrixId
      ) as RawInstanceRow[]
      return { task, instances: instRaws.map(mapInstanceRow) }
    })
  }

  deleteTask(motrixId: string): void {
    // FOREIGN KEY ON DELETE CASCADE removes task_instances automatically.
    // task_files still references motrix_id directly — delete explicitly.
    // task_occurrences has no FK, so it needs the same explicit delete: per
    // spec §2 retention, ALL occurrence rows for a task — dispatched or
    // not — must die with the task row in the same transaction. Deleting
    // only dispatched rows would leave undispatched rows behind for a task
    // that no longer exists, which would surface as ghost notifications if
    // ever replayed. notification_occurrences (the notification ledger)
    // gets the same explicit delete for the same reason — its rows carry
    // no FK either. The notifications DISPLAY rows are deliberately left
    // alone: they are user-facing history and must survive task deletion.
    this.db.transaction(() => {
      this.stmtDeleteFiles.run(motrixId)
      this.stmtDeleteTaskOccurrences.run(motrixId)
      this.stmtDeleteNotificationLedgerForTask.run(motrixId)
      this.stmtDeleteTask.run(motrixId)
    })()
    this.lastPersistedSig.delete(motrixId)
  }

  /**
   * Delete task history as one SQLite transaction. Persisted signatures are
   * evicted only after commit so a failed transaction cannot desynchronize
   * the in-memory write-skip cache from the database.
   */
  deleteTasks(motrixIds: readonly string[]): void {
    const ids = [...new Set(motrixIds)]
    if (ids.length === 0) return

    this.db.transaction(() => {
      for (const motrixId of ids) {
        // FOREIGN KEY ON DELETE CASCADE removes task_instances. task_files,
        // task_occurrences, and notification_occurrences have no such FK,
        // so all three are deleted explicitly, in the same transaction as
        // the task row — per spec §2 retention, ALL occurrence rows for a
        // task die with it (see the matching comment in deleteTask above)
        // to prevent ghost notifications from an orphaned undispatched
        // row. notifications DISPLAY rows are left alone — user-facing
        // history survives task deletion.
        this.stmtDeleteFiles.run(motrixId)
        this.stmtDeleteTaskOccurrences.run(motrixId)
        this.stmtDeleteNotificationLedgerForTask.run(motrixId)
        this.stmtDeleteTask.run(motrixId)
      }
    })()

    for (const motrixId of ids) {
      this.lastPersistedSig.delete(motrixId)
    }
  }

  replaceInstances(motrixId: string, instances: TaskInstanceRow[]): void {
    this.db.transaction(() => {
      this.stmtDeleteInstancesForTask.run(motrixId)
      for (const inst of instances) {
        this.stmtInsertInstance.run(this.serializeInstance(inst))
      }
    })()
    // Instances changed outside writeRow — drop the stale signature so the
    // next saveTasksBatch rewrites this task instead of skipping it.
    this.lastPersistedSig.delete(motrixId)
  }

  deleteInstance(instanceId: string): void {
    this.stmtDeleteInstance.run(instanceId)
    // No motrixId here; clear all signatures so no task is skipped on stale
    // state. (No production caller today; this is a fail-safe.)
    this.lastPersistedSig.clear()
  }

  replaceTaskFiles(motrixId: string, files: TaskFileRow[]): void {
    const tx = this.db.transaction((rows: TaskFileRow[]) =>
      this.writeTaskFiles(motrixId, rows)
    )
    tx(files)
  }

  getTaskFiles(motrixId: string): TaskFileRow[] {
    return (
      this.stmtGetFiles.all(motrixId) as Array<{
        file_index: number
        path: string
        size: number
        selected: number
      }>
    ).map((r) => ({
      fileIndex: r.file_index,
      path: r.path,
      size: r.size,
      selected: r.selected === 1,
    }))
  }

  /**
   * Upsert a task and (optionally) append one occurrence outbox row in a
   * single SQLite transaction — the terminal/diagnosis write and its outbox
   * entry must commit or roll back together, never independently. Reuses
   * `writeRow` (the same upsert `saveTaskWithInstances` uses) rather than
   * duplicating the task SQL. The occurrence insert is `INSERT OR IGNORE` on
   * `occurrence_id`: a duplicate id (e.g. a re-dispatched or replayed write)
   * is a silent no-op, while the task row above it still commits.
   */
  persistTaskWithOccurrence(
    payload: TaskWithInstances,
    occurrence: TaskOccurrence | null
  ): void {
    this.db.transaction(() => {
      this.writeRow(payload)
      if (occurrence) {
        this.stmtInsertOccurrenceOrIgnore.run(
          this.serializeOccurrence(occurrence)
        )
      }
      this.lastPersistedSig.set(
        payload.task.motrixId,
        this.rowSignature(payload)
      )
    })()
  }

  /**
   * H12/H20 terminal commit boundary. The final task graph, rebased task
   * files, staged per-plugin metadata, finalize journal phase, terminal
   * occurrence, and every post-Hook admission/tombstone are one SQLite
   * transaction. Nothing from a failed commit is externally durable.
   */
  commitTerminalHookBoundary(
    input: TerminalHookCommitInput
  ): PostDeliveryAdmissionSummary {
    const deliveries = input.postDeliveries ?? []
    const quota = input.postQuota ?? DEFAULT_POST_DELIVERY_QUOTA_CONFIG
    const signature = this.rowSignature(input.payload)
    const summary = this.db.transaction(() => {
      if (deliveries.length > 0 && !input.occurrence) {
        throw new Error('post deliveries require a durable occurrence identity')
      }
      input.beforeCommit?.()
      this.writeRow(input.payload)
      if (input.files) {
        this.writeTaskFiles(input.payload.task.motrixId, [...input.files])
      }
      this.applyStagedMetadata(
        input.payload.task.motrixId,
        input.metadataOps ?? [],
        input.payload.task.updatedAt
      )
      if (input.fileRebase) {
        this.rebaseTaskFilesInCurrentTransaction(
          input.payload.task.motrixId,
          input.fileRebase.sourceRoot,
          input.fileRebase.targetRoot
        )
      }
      const occurrenceWasDuplicate = input.occurrence
        ? this.stmtInsertOccurrenceOrIgnore.run(
            this.serializeOccurrence(input.occurrence)
          ).changes === 0
        : false
      if (input.finalizeJournal) {
        const journal = input.finalizeJournal
        if (journal.taskId !== input.payload.task.motrixId) {
          throw new Error('finalize journal task does not match terminal task')
        }
        const persisted = this.db
          .prepare(
            `SELECT plan_json FROM plugin_finalize_journals
             WHERE plan_id=? AND task_id=? AND phase='target_installed'`
          )
          .get(journal.journalId, journal.taskId) as
          | { plan_json: string }
          | undefined
        if (!persisted) {
          throw new Error('finalize journal is not ready for terminal commit')
        }
        const parsed: unknown = JSON.parse(persisted.plan_json)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('finalize journal payload is invalid')
        }
        const record = parsed as Record<string, unknown>
        if (
          record.journalId !== journal.journalId ||
          (record.plan as { taskId?: unknown } | undefined)?.taskId !==
            journal.taskId
        ) {
          throw new Error('finalize journal payload identity mismatch')
        }
        const committedRecord = JSON.stringify({
          ...record,
          phase: 'db_committed',
          targetIdentity: journal.targetIdentity,
        })
        const changed = this.db
          .prepare(
            `UPDATE plugin_finalize_journals
             SET phase='db_committed', plan_json=?,
                 target_identity_json=?, updated_at=?
             WHERE plan_id=? AND task_id=? AND phase='target_installed'`
          )
          .run(
            committedRecord,
            JSON.stringify(journal.targetIdentity),
            journal.updatedAt,
            journal.journalId,
            journal.taskId
          ).changes
        if (changed !== 1) {
          throw new Error('finalize journal is not ready for terminal commit')
        }
      }
      // The occurrence id is the durable admission idempotency boundary. A
      // replay of a committed terminal occurrence must not count a second
      // quota tombstone even when the rejected delivery has no row of its own.
      if (occurrenceWasDuplicate) {
        return {
          admitted: 0,
          duplicates: deliveries.length,
          rejected: 0,
          results: deliveries.map((delivery) => ({
            kind: 'duplicate' as const,
            deliveryId: delivery.deliveryId,
          })),
        }
      }
      return admitPostDeliveries(this.durablePostDeliveries, deliveries, quota)
    })()
    this.lastPersistedSig.set(input.payload.task.motrixId, signature)
    return summary
  }

  private applyStagedMetadata(
    taskId: string,
    operations: readonly StagedMetadataOp[],
    updatedAt: number
  ): void {
    if (operations.length === 0) return
    const insert = this.db.prepare(
      `INSERT INTO plugin_task_metadata
         (task_id, plugin_id, key, value, size, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, plugin_id, key) DO UPDATE SET
         value=excluded.value, size=excluded.size,
         updated_at=excluded.updated_at`
    )
    const remove = this.db.prepare(
      `DELETE FROM plugin_task_metadata
       WHERE task_id=? AND plugin_id=? AND key=?`
    )
    const usage = this.db.prepare(
      `SELECT COALESCE(SUM(size), 0) AS bytes
       FROM plugin_task_metadata WHERE task_id=? AND plugin_id=?`
    )
    const prior = this.db.prepare(
      `SELECT size FROM plugin_task_metadata
       WHERE task_id=? AND plugin_id=? AND key=?`
    )
    const projectedByPlugin = new Map<string, number>()

    for (const operation of operations) {
      const current =
        projectedByPlugin.get(operation.pluginId) ??
        (usage.get(taskId, operation.pluginId) as { bytes: number }).bytes
      const previous = prior.get(taskId, operation.pluginId, operation.key) as
        | { size: number }
        | undefined
      if (operation.op === 'delete') {
        remove.run(taskId, operation.pluginId, operation.key)
        projectedByPlugin.set(
          operation.pluginId,
          Math.max(0, current - (previous?.size ?? 0))
        )
        continue
      }
      const json = JSON.stringify(operation.value)
      if (json === undefined) {
        throw new TypeError('staged plugin metadata is not JSON serializable')
      }
      const size = Buffer.byteLength(json, 'utf8')
      if (operation.size !== undefined && operation.size !== size) {
        throw new TypeError('staged plugin metadata size does not match value')
      }
      const projected = current - (previous?.size ?? 0) + size
      if (projected > 64 * 1024) {
        throw new RangeError('staged plugin metadata exceeds per-task quota')
      }
      insert.run(
        taskId,
        operation.pluginId,
        operation.key,
        json,
        size,
        Math.max(1, updatedAt)
      )
      projectedByPlugin.set(operation.pluginId, projected)
    }
  }

  private rebaseTaskFilesInCurrentTransaction(
    taskId: string,
    sourceRoot: string,
    targetRoot: string
  ): void {
    const rows = this.stmtGetFiles.all(taskId) as TaskFileRow[]
    let changed = false
    const rebased = rows.map((row) => {
      if (!row.path) return row
      const relative = path.relative(sourceRoot, row.path)
      if (relative.startsWith('..') || path.isAbsolute(relative)) return row
      changed = true
      return {
        ...row,
        path: relative === '' ? targetRoot : path.join(targetRoot, relative),
      }
    })
    if (changed) this.writeTaskFiles(taskId, rebased)
  }

  /**
   * CAS-guarded diagnosis upgrade. Reads the row's current revision and
   * error group, then decides, all inside one transaction:
   *
   * - `'conflict'` — the task is gone, or its `diagnosis_revision` no longer
   *   equals `expectedRevision` (a concurrent upgrade already won).
   * - `'unchanged'` — the revision matches and the **stored** group already
   *   equals the requested one. Nothing is written and no occurrence is
   *   emitted, which makes re-submitting a diagnosis safe to repeat.
   * - `'updated'` — the group differed; the row and its revision are
   *   updated and the diagnosis occurrence is inserted in the same
   *   transaction.
   *
   * The comparison deliberately runs against the stored row rather than the
   * caller's in-memory snapshot: a caller holding a stale task would
   * otherwise get `'unchanged'` for a group that no longer matches the
   * database, and report success for an upgrade that never happened.
   */
  applyDiagnosisUpgradeRow(params: {
    motrixId: string
    expectedRevision: number
    nextRevision: number
    errorCode: DownloadErrorCode | null
    errorMessage: string | null
    errorDetailKey: string | null
    errorDetailParams: Record<string, string> | null
    occurrence: TaskDiagnosisOccurrence
  }): DiagnosisUpgradeRowOutcome {
    const next: TaskErrorFields = {
      errorCode: params.errorCode,
      errorMessage: params.errorMessage,
      errorDetailKey: params.errorDetailKey,
      errorDetailParams: params.errorDetailParams,
    }
    const outcome = this.db.transaction((): DiagnosisUpgradeRowOutcome => {
      const row = this.stmtReadDiagnosisGroup.get(params.motrixId) as
        | {
            diagnosis_revision: number
            error_code: string | null
            error_message: string | null
            error_detail_key: string | null
            error_detail_params: string | null
          }
        | undefined
      if (!row || row.diagnosis_revision !== params.expectedRevision) {
        return 'conflict'
      }
      const current: TaskErrorFields = {
        errorCode: (row.error_code as DownloadErrorCode | null) ?? null,
        errorMessage: row.error_message,
        errorDetailKey: row.error_detail_key,
        errorDetailParams: parseDetailParams(row.error_detail_params),
      }
      if (taskErrorFieldsEqual(current, next)) return 'unchanged'

      this.stmtApplyDiagnosisUpgrade.run({
        motrixId: params.motrixId,
        expectedRevision: params.expectedRevision,
        nextRevision: params.nextRevision,
        errorCode: params.errorCode,
        errorMessage: params.errorMessage,
        errorDetailKey: params.errorDetailKey,
        errorDetailParams:
          params.errorDetailParams === null
            ? null
            : JSON.stringify(params.errorDetailParams),
      })
      this.stmtInsertOccurrenceOrIgnore.run(
        this.serializeOccurrence(params.occurrence)
      )
      return 'updated'
    })()
    // The row changed outside writeRow — drop the stale write-skip
    // signature so the next saveTasksBatch doesn't mistake the old
    // in-memory content hash for what's now on disk.
    if (outcome === 'updated') this.lastPersistedSig.delete(params.motrixId)
    return outcome
  }

  /** Undispatched outbox rows, oldest first — the order the dispatcher must
   *  deliver them in. Rows whose payload fails Zod validation are logged and
   *  skipped rather than thrown, so one corrupt row cannot wedge startup drain. */
  listUndispatchedOccurrences(): TaskOccurrence[] {
    const rows = this.stmtListUndispatchedOccurrences.all() as Array<{
      occurrence_id: string
      payload: string
    }>
    const occurrences: TaskOccurrence[] = []
    for (const row of rows) {
      const occurrence = parseOccurrencePayload(row.occurrence_id, row.payload)
      if (occurrence) occurrences.push(occurrence)
    }
    return occurrences
  }

  markOccurrenceDispatched(occurrenceId: string): void {
    this.stmtMarkOccurrenceDispatched.run(Date.now(), occurrenceId)
  }

  /** Standalone occurrence-row cleanup for a single task. NOT called from
   *  deleteTask/deleteTasks — those run the equivalent prepared statement
   *  directly inside their own transaction (see the retention comment
   *  there); this public method exists for callers that need to clear a
   *  task's occurrence rows without deleting the task row itself.
   *  Occurrence rows carry no FK to `tasks`, so this is an explicit delete
   *  rather than an ON DELETE CASCADE. */
  deleteTaskOccurrences(taskId: string): void {
    this.stmtDeleteTaskOccurrences.run(taskId)
  }

  /**
   * Insert a notification's ledger row and its display row atomically.
   *
   * The ledger (`notification_occurrences`) is must-reach/transactional and
   * survives display-row deletion — it exists purely to make delivery
   * idempotent under `sourceKey`. `INSERT OR IGNORE` on the ledger first:
   * if it reports zero changes, an occurrence with this `sourceKey` was
   * already recorded (delivered or superseded), so the whole call is a
   * no-op and returns `null` — even if the earlier display row was since
   * deleted or pruned. Only a genuinely new `sourceKey` proceeds to insert
   * the display row and run the cap prune, all inside the same
   * transaction: a failure anywhere (including a broken display insert)
   * rolls back the ledger insert too, so the `sourceKey` is never burned
   * without a corresponding notification and a retry can succeed.
   *
   * Two narrow races are treated as "stale, retry" rather than as errors —
   * both roll back the ledger insert (via `NotificationInsertStaleError`,
   * caught just below) and return `null`, same as the ordinary
   * already-delivered case above:
   *
   * - **F3**: `idx_notifications_source_key` (a partial UNIQUE index on
   *   `notifications.source_key`) is a hard backstop against a duplicate
   *   display row racing past the ledger's `changes === 0` check (e.g. a
   *   future consumer that awaits real I/O between the ledger check and the
   *   display insert). If the display insert hits that constraint, the
   *   ledger said "fresh" but a display row for this `sourceKey` already
   *   exists — stale, not a genuine failure.
   * - **F6**: an insert whose `createdAt` sorts behind rows already present
   *   can land outside the cap window and get deleted by the very prune
   *   that runs later in this same transaction. This isn't only a
   *   clock-rollback story: since Task 1 stamps notifications with the
   *   underlying occurrence's own timestamp (not delivery time), a
   *   crash-replay drain of genuinely old, previously-undelivered
   *   occurrences can produce a legitimately old `createdAt` that lands
   *   the same way — no clock skew involved, just a late delivery of old
   *   news. Either way, rather than return a row that's already gone (and
   *   broadcast `NotificationAdded` for it), the post-prune existence check
   *   below detects that and rolls back too — the insert is dropped as
   *   stale, `sourceKey` unburned, and a retry with a sane timestamp can
   *   succeed. Dropping it is acceptable either way: a row that lands
   *   beyond the `NOTIFICATION_DISPLAY_CAP`-row cap window is already
   *   beyond `listNotifications`'s own `NOTIFICATION_LIST_LIMIT` (100 rows)
   *   — nothing user-visible was going to surface it regardless.
   */
  insertNotificationWithLedger(
    input: NewNotificationInput
  ): AppNotification | null {
    try {
      return this.db.transaction((): AppNotification | null => {
        const inserted = this.stmtInsertNotificationOccurrenceOrIgnore.run(
          input.sourceKey,
          input.taskId,
          input.createdAt
        )
        if (inserted.changes === 0) return null

        const id = randomUUID()
        try {
          this.stmtInsertNotification.run({
            id,
            sourceKey: input.sourceKey,
            kind: input.kind,
            severity: input.severity,
            titleKey: input.titleKey,
            titleParams:
              input.titleParams === null
                ? null
                : JSON.stringify(input.titleParams),
            bodyKey: input.bodyKey,
            bodyParams:
              input.bodyParams === null
                ? null
                : JSON.stringify(input.bodyParams),
            taskId: input.taskId,
            createdAt: input.createdAt,
          })
        } catch (err) {
          // F3: only the partial UNIQUE backstop on source_key is treated
          // as stale — any other constraint violation (e.g. a forced test
          // trigger, or an unrelated UNIQUE index) still propagates as a
          // genuine error. better-sqlite3 formats the message as
          // "UNIQUE constraint failed: notifications.source_key"; matching
          // on it (not just the SQLITE_CONSTRAINT_UNIQUE code) keeps this
          // narrow to the one column F3 backstops.
          if (
            err instanceof Database.SqliteError &&
            err.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
            err.message.includes('notifications.source_key')
          ) {
            throw new NotificationInsertStaleError()
          }
          throw err
        }
        // Cap prune runs inside this same transaction — see
        // stmtPruneNotifications for why the display table never exceeds
        // NOTIFICATION_DISPLAY_CAP rows, even momentarily.
        this.stmtPruneNotifications.run()

        // F6: the row just inserted above may have been the one the prune
        // just deleted (clock-rollback beyond the cap window) — verify it
        // survived before handing it back and emitting NotificationAdded.
        if (this.stmtNotificationExistsById.get(id) === undefined) {
          throw new NotificationInsertStaleError()
        }

        return {
          id,
          sourceKey: input.sourceKey,
          kind: input.kind,
          severity: input.severity,
          titleKey: input.titleKey,
          titleParams: input.titleParams,
          bodyKey: input.bodyKey,
          bodyParams: input.bodyParams,
          taskId: input.taskId,
          createdAt: input.createdAt,
          readAt: null,
        }
      })()
    } catch (err) {
      if (err instanceof NotificationInsertStaleError) return null
      throw err
    }
  }

  /** Display rows, newest first. Malformed `title_params`/`body_params`
   *  JSON on disk reads back as `null` (validate-on-read) rather than
   *  throwing or trusting an unreadable value. */
  listNotifications(limit = NOTIFICATION_LIST_LIMIT): AppNotification[] {
    const rows = this.stmtListNotifications.all(limit) as RawNotificationRow[]
    return rows.map(mapNotificationRow)
  }

  getUnreadNotificationCount(): number {
    const row = this.stmtGetUnreadNotificationCount.get() as { c: number }
    return row.c
  }

  markNotificationRead(id: string, readAt: number): boolean {
    return this.stmtMarkNotificationRead.run(readAt, id).changes > 0
  }

  markAllNotificationsRead(readAt: number): number {
    return this.stmtMarkAllNotificationsRead.run(readAt).changes
  }

  deleteNotification(id: string): boolean {
    return this.stmtDeleteNotification.run(id).changes > 0
  }

  /** Display table only — the ledger (`notification_occurrences`) is
   *  untouched by delete/clear/prune, per the delivery-idempotency spec. */
  clearNotifications(): number {
    return this.stmtClearNotifications.run().changes
  }

  updateNotificationBySourceKey(
    sourceKey: string,
    patch: { bodyKey: string | null; bodyParams: Record<string, string> | null }
  ): boolean {
    return (
      this.stmtUpdateNotificationBySourceKey.run(
        patch.bodyKey,
        patch.bodyParams === null ? null : JSON.stringify(patch.bodyParams),
        sourceKey
      ).changes > 0
    )
  }

  /** Retention sweep for engine/ad-hoc ledger rows (`task_id IS NULL`) —
   *  task-bound ledger rows are retired by `deleteTask`/`deleteTasks`
   *  instead, so this must never touch rows with a non-null `task_id`. */
  deleteEngineNotificationLedgerBefore(cutoff: number): number {
    return this.stmtDeleteEngineNotificationLedgerBefore.run(cutoff).changes
  }

  getRawForTesting(): BetterSqlite3.Database {
    return this.db
  }

  close(): void {
    this.db.close()
  }

  private serializeTask(t: TaskRow): Record<string, unknown> {
    return {
      motrixId: t.motrixId,
      name: t.name,
      kind: t.kind,
      taskType: t.taskType,
      category: t.category,
      priority: t.priority,
      tags: t.tags,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      finalPath: t.finalPath,
      finalName: t.finalName,
      torrentMetaPath: t.torrentMetaPath,
      infoHash: t.infoHash,
      totalBytes: t.totalBytes,
      downloadedBytes: t.downloadedBytes,
      sizeWhenDone: t.sizeWhenDone,
      fileCount: t.fileCount,
      isPrivate: t.isPrivate ? 1 : 0,
      trackers: JSON.stringify(t.trackers ?? []),
      pieceLength: t.pieceLength,
      aggStatus: t.aggStatus,
      finishedAt: t.finishedAt,
      errorMessage: t.errorMessage,
      errorCode: t.errorCode,
      errorDetailKey: t.errorDetailKey,
      errorDetailParams:
        t.errorDetailParams === null
          ? null
          : JSON.stringify(t.errorDetailParams),
      diagnosisRevision: t.diagnosisRevision,
      uploadedBytesBaseline: t.uploadedBytesBaseline,
      source: t.source,
      sourceMeta: t.sourceMeta === null ? null : JSON.stringify(t.sourceMeta),
    }
  }

  private serializeInstance(i: TaskInstanceRow): Record<string, unknown> {
    return {
      instanceId: i.instanceId,
      motrixId: i.motrixId,
      gid: i.gid,
      phase: i.phase,
      status: i.status,
      progress: i.progress,
      totalBytes: i.totalBytes,
      downloadedBytes: i.downloadedBytes,
      uploadedBytes: i.uploadedBytes,
      diskPath: i.diskPath,
      transitionPhase: i.transitionPhase,
      uris: JSON.stringify(i.uris ?? []),
      uriHash: i.uriHash,
      payload: JSON.stringify(i.payload ?? {}),
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    }
  }

  /** `from_status`/`to_status`/`cause`/`revision` are queryable projections
   *  of the discriminated union; `payload` carries the full occurrence and
   *  is the sole source of truth on read (see `parseOccurrencePayload`). */
  private serializeOccurrence(occ: TaskOccurrence): Record<string, unknown> {
    return {
      occurrenceId: occ.occurrenceId,
      type: occ.type,
      taskId: occ.taskId,
      fromStatus: occ.type === 'terminal' ? occ.fromStatus : null,
      toStatus: occ.type === 'terminal' ? occ.toStatus : null,
      cause: occ.type === 'terminal' ? occ.cause : null,
      revision: occ.type === 'diagnosis' ? occ.revision : null,
      payload: JSON.stringify(occ),
      createdAt: occ.createdAt,
    }
  }
}

interface RawTaskRow {
  motrix_id: string
  name: string
  kind: string
  task_type: string
  category: string | null
  priority: number
  tags: string | null
  created_at: number
  updated_at: number
  final_path: string
  final_name: string
  torrent_meta_path: string | null
  info_hash: string | null
  total_bytes: number
  downloaded_bytes: number
  size_when_done: number
  file_count: number
  is_private: number
  trackers: string
  piece_length: number
  agg_status: string
  finished_at: number | null
  error_message: string | null
  error_code: string | null
  error_detail_key: string | null
  error_detail_params: string | null
  diagnosis_revision: number
  uploaded_bytes_baseline: number
  source: string
  source_meta: string | null
}

interface RawInstanceRow {
  instance_id: string
  motrix_id: string
  gid: string | null
  phase: string
  status: string
  progress: number
  total_bytes: number
  downloaded_bytes: number
  uploaded_bytes: number
  disk_path: string
  transition_phase: string
  uris: string
  uri_hash: string | null
  payload: string
  created_at: number
  updated_at: number
}

interface RawNotificationRow {
  id: string
  source_key: string | null
  kind: string
  severity: string
  title_key: string
  title_params: string | null
  body_key: string | null
  body_params: string | null
  task_id: string | null
  created_at: number
  read_at: number | null
}

function mapTaskRow(row: RawTaskRow): TaskRow {
  return {
    motrixId: row.motrix_id,
    name: row.name,
    kind: toTaskKind(row.kind),
    taskType: toTaskType(row.task_type),
    category: row.category,
    priority: row.priority,
    tags: row.tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finalPath: row.final_path,
    finalName: row.final_name,
    torrentMetaPath: row.torrent_meta_path,
    infoHash: row.info_hash,
    totalBytes: row.total_bytes,
    downloadedBytes: row.downloaded_bytes,
    sizeWhenDone: row.size_when_done,
    fileCount: row.file_count,
    isPrivate: row.is_private === 1,
    trackers: parseTrackers(row.trackers),
    pieceLength: row.piece_length,
    aggStatus: toTaskStatus(row.agg_status),
    finishedAt: row.finished_at,
    errorMessage: row.error_message,
    errorCode: toDownloadErrorCode(row.error_code),
    errorDetailKey: row.error_detail_key,
    errorDetailParams: parseDetailParams(row.error_detail_params),
    diagnosisRevision: row.diagnosis_revision,
    uploadedBytesBaseline: row.uploaded_bytes_baseline,
    source: (row.source as TaskSource) ?? 'user',
    sourceMeta:
      row.source_meta == null
        ? null
        : (JSON.parse(row.source_meta as string) as SourceMeta),
  }
}

function mapInstanceRow(row: RawInstanceRow): TaskInstanceRow {
  return {
    instanceId: row.instance_id,
    motrixId: row.motrix_id,
    gid: row.gid,
    phase: toInstancePhase(row.phase),
    status: toTaskStatus(row.status),
    progress: row.progress,
    totalBytes: row.total_bytes,
    downloadedBytes: row.downloaded_bytes,
    uploadedBytes: row.uploaded_bytes,
    diskPath: row.disk_path,
    transitionPhase: toTransitionPhase(row.transition_phase),
    uris: parseUris(row.uris),
    uriHash: row.uri_hash,
    payload: parsePayload(row.payload),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapNotificationRow(row: RawNotificationRow): AppNotification {
  return {
    id: row.id,
    sourceKey: row.source_key,
    kind: row.kind,
    severity: row.severity as NotificationSeverity,
    titleKey: row.title_key,
    titleParams: parseNotificationParams(
      row.id,
      'title_params',
      row.title_params
    ),
    bodyKey: row.body_key,
    bodyParams: parseNotificationParams(row.id, 'body_params', row.body_params),
    taskId: row.task_id,
    createdAt: row.created_at,
    readAt: row.read_at,
  }
}

/** Parse + validate a `notifications.title_params`/`body_params` JSON
 *  blob. Returns `null` (after logging a warning) on a JSON parse failure
 *  or a schema mismatch, so a corrupted/hand-edited column reads back as
 *  absent rather than throwing or trusting an unreadable value. */
function parseNotificationParams(
  notificationId: string,
  column: 'title_params' | 'body_params',
  raw: string | null
): Record<string, string> | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    log.warn(
      { notificationId, column, err },
      'skipping notification params with unparsable JSON'
    )
    return null
  }
  const result = NOTIFICATION_PARAMS_SCHEMA.safeParse(parsed)
  if (!result.success) {
    log.warn(
      { notificationId, column, issues: result.error.issues },
      'skipping notification params with malformed shape'
    )
    return null
  }
  return result.data
}

function parseTrackers(raw: string | null): string[][] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((tier): tier is unknown[] => Array.isArray(tier))
      .map((tier) => tier.filter((u): u is string => typeof u === 'string'))
  } catch {
    return []
  }
}

function parseUris(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((u) => typeof u === 'string')
      : []
  } catch {
    return []
  }
}

function parsePayload(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Parse + validate a `task_occurrences.payload` blob. Returns null (after
 *  logging a warning) on a JSON parse failure or a schema mismatch, so a
 *  corrupted row is skipped by its caller instead of crashing the read. */
function parseOccurrencePayload(
  occurrenceId: string,
  raw: string
): TaskOccurrence | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    log.warn(
      { occurrenceId, err },
      'skipping task occurrence with unparsable payload JSON'
    )
    return null
  }
  const result = TASK_OCCURRENCE_SCHEMA.safeParse(parsed)
  if (!result.success) {
    log.warn(
      { occurrenceId, issues: result.error.issues },
      'skipping task occurrence with malformed payload'
    )
    return null
  }
  return result.data
}

function toTaskKind(raw: string): TaskKind {
  if (Object.values(TaskKind).includes(raw as TaskKind)) {
    return raw as TaskKind
  }
  return TaskKind.Direct
}

function toTaskType(raw: string): TaskType {
  if (Object.values(TaskType).includes(raw as TaskType)) {
    return raw as TaskType
  }
  return TaskType.Http
}

function toDownloadErrorCode(raw: string | null): DownloadErrorCode | null {
  if (raw === null) return null
  if (isDownloadErrorCode(raw)) {
    return raw
  }
  return DownloadErrorCode.Unknown
}

function isDownloadErrorCode(raw: string): raw is DownloadErrorCode {
  return Object.values(DownloadErrorCode).some((value) => value === raw)
}

function toInstancePhase(raw: string): TaskInstancePhase {
  if (Object.values(TaskInstancePhase).includes(raw as TaskInstancePhase)) {
    return raw as TaskInstancePhase
  }
  return TaskInstancePhase.HttpDownload
}

function toTransitionPhase(raw: string): TransitionPhase {
  if (
    raw === TransitionPhase.Renaming ||
    raw === TransitionPhase.Reseeding ||
    raw === TransitionPhase.Idle
  ) {
    return raw
  }
  return TransitionPhase.Idle
}

function toTaskStatus(raw: string): TaskStatus {
  if (Object.values(TaskStatus).includes(raw as TaskStatus)) {
    return raw as TaskStatus
  }
  return TaskStatus.Queued
}
