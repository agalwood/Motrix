import path from 'node:path'
import { artifactIdentityEquals } from '@core/plugin/finalize/artifact-identity'
import type {
  FinalizeJournalPhase,
  FinalizeJournalRecord,
  FinalizeJournalRepository,
} from '@core/plugin/finalize/finalize-committer'
import { finalizePathsEquivalent } from '@core/plugin/finalize/finalize-committer'
import { isRetryableMoveQuarantine } from '@core/plugin/finalize/finalize-recovery'
import { assertValidHookPlan } from '@core/plugin/finalize/hook-plan'
import type Database from 'better-sqlite3'
import { z } from 'zod'

interface RawFinalizeJournal {
  plan_id: string
  task_id: string
  phase: FinalizeJournalPhase | 'quarantined'
  plan_json: string
  source_identity_json: string
  target_identity_json: string | null
  quarantine_reason: string | null
  created_at: number
  updated_at: number
}

export interface SqliteFinalizeJournalRepositoryOptions {
  now?: () => number
  /**
   * Must execute the complete task terminal transaction and move this journal
   * from target_installed to db_committed within that same transaction.
   */
  commitTerminalBoundary(record: FinalizeJournalRecord): void
}

/** Durable finalize state machine. Malformed recovery rows are quarantined. */
export class SqliteFinalizeJournalRepository
  implements FinalizeJournalRepository
{
  private readonly now: () => number

  constructor(
    private readonly db: Database.Database,
    private readonly options: SqliteFinalizeJournalRepositoryOptions
  ) {
    this.now = options.now ?? Date.now
  }

  async prepare(record: FinalizeJournalRecord): Promise<void> {
    if (record.phase !== 'prepared') {
      throw new Error('new finalize journal must start prepared')
    }
    assertValidHookPlan(record.plan)
    if (record.journalId !== record.plan.planId) {
      throw new Error('finalize journal id must match plan id')
    }
    const now = Math.max(1, this.now())
    this.db.transaction(() => {
      const prior = this.db
        .prepare(
          `SELECT plan_id, phase FROM plugin_finalize_journals WHERE task_id=?`
        )
        .get(record.plan.taskId) as
        | { plan_id: string; phase: RawFinalizeJournal['phase'] }
        | undefined
      if (prior) {
        if (prior.phase !== 'cleaned') {
          throw new Error(
            `task already has an unfinished finalize journal: ${prior.plan_id}`
          )
        }
        this.db
          .prepare(
            `DELETE FROM plugin_finalize_journals
             WHERE task_id=? AND phase='cleaned'`
          )
          .run(record.plan.taskId)
      }
      this.db
        .prepare(
          `INSERT INTO plugin_finalize_journals (
            plan_id, task_id, phase, plan_json, source_identity_json,
            target_identity_json, quarantine_reason, created_at, updated_at
          ) VALUES (?, ?, 'prepared', ?, ?, NULL, NULL, ?, ?)`
        )
        .run(
          record.journalId,
          record.plan.taskId,
          serializeRecord(record),
          JSON.stringify(record.plan.sourceIdentity),
          now,
          now
        )
    })()
  }

  async checkpoint(
    journalId: string,
    patch: Partial<
      Pick<
        FinalizeJournalRecord,
        | 'privateTargetPath'
        | 'privateTargetIdentity'
        | 'targetIdentity'
        | 'rollbackPath'
        | 'removalIntent'
        | 'publicationIntent'
      >
    >
  ): Promise<void> {
    this.db.transaction(() => {
      const current = this.requireRecord(journalId)
      if (current.phase === 'cleaned') {
        throw new Error(`cannot checkpoint terminal finalize journal`)
      }
      const next: FinalizeJournalRecord = { ...current, ...patch }
      validateIntents(next)
      const changed = this.db
        .prepare(
          `UPDATE plugin_finalize_journals
           SET plan_json=?, target_identity_json=?, updated_at=?
           WHERE plan_id=? AND phase=?`
        )
        .run(
          serializeRecord(next),
          next.targetIdentity ? JSON.stringify(next.targetIdentity) : null,
          Math.max(1, this.now()),
          journalId,
          current.phase
        ).changes
      if (changed !== 1) throw new Error('finalize journal checkpoint lost CAS')
    })()
  }

  async advance(
    journalId: string,
    phase: FinalizeJournalPhase,
    patch: Partial<
      Pick<
        FinalizeJournalRecord,
        | 'privateTargetPath'
        | 'privateTargetIdentity'
        | 'targetIdentity'
        | 'rollbackPath'
        | 'quarantineReason'
      >
    > = {}
  ): Promise<void> {
    this.db.transaction(() => {
      const current = this.requireRecord(journalId)
      if (current.phase === phase) return
      if (!transitionAllowed(current, phase)) {
        throw new Error(
          `invalid finalize transition ${current.phase} -> ${phase}`
        )
      }
      const next: FinalizeJournalRecord = { ...current, ...patch, phase }
      const changed = this.db
        .prepare(
          `UPDATE plugin_finalize_journals
           SET phase=?, plan_json=?, target_identity_json=?, updated_at=?
           WHERE plan_id=? AND phase=?`
        )
        .run(
          phase,
          serializeRecord(next),
          next.targetIdentity ? JSON.stringify(next.targetIdentity) : null,
          Math.max(1, this.now()),
          journalId,
          current.phase
        ).changes
      if (changed !== 1) throw new Error('finalize journal transition lost CAS')
    })()
  }

  async commitTerminal(record: FinalizeJournalRecord): Promise<void> {
    this.db.transaction(() => {
      const durable = this.requireRecord(record.journalId)
      if (durable.phase === 'db_committed') return
      if (durable.phase !== 'target_installed') {
        throw new Error('finalize journal target is not installed')
      }
      this.options.commitTerminalBoundary(durable)
      const committed = this.readRaw(record.journalId)
      if (committed?.phase !== 'db_committed') {
        throw new Error(
          'terminal boundary returned without atomically committing journal'
        )
      }
    })()
  }

  async quarantine(journalId: string, reason: string): Promise<void> {
    const boundedReason = reason.slice(0, 256) || 'unknown finalize fault'
    const changed = this.db
      .prepare(
        `UPDATE plugin_finalize_journals
         SET phase='quarantined', quarantine_reason=?, updated_at=?
         WHERE plan_id=? AND phase <> 'cleaned'`
      )
      .run(boundedReason, Math.max(1, this.now()), journalId).changes
    if (changed === 0) {
      const row = this.readRaw(journalId)
      if (!row) throw new Error('finalize journal does not exist')
      if (row.phase !== 'quarantined') {
        throw new Error('cannot quarantine cleaned finalize journal')
      }
    }
  }

  async listRecoverable(taskId?: string): Promise<FinalizeJournalRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM plugin_finalize_journals
         WHERE phase <> 'cleaned' AND (? IS NULL OR task_id=?)
         ORDER BY created_at, plan_id`
      )
      .all(taskId ?? null, taskId ?? null) as RawFinalizeJournal[]
    const records: FinalizeJournalRecord[] = []
    for (const row of rows) {
      try {
        if (row.phase === 'quarantined') {
          const candidate = parseQuarantinedMove(row)
          if (candidate) records.push(candidate)
        } else {
          records.push(parseRecord(row))
        }
      } catch (error) {
        if (row.phase === 'quarantined') continue
        await this.quarantine(
          row.plan_id,
          `invalid persisted finalize journal: ${errorMessage(error)}`
        )
      }
    }
    return records
  }

  async resumeQuarantined(record: FinalizeJournalRecord): Promise<void> {
    this.db.transaction(() => {
      const raw = this.readRaw(record.journalId)
      const candidate = raw && parseQuarantinedMove(raw)
      if (!candidate || JSON.stringify(candidate) !== JSON.stringify(record)) {
        throw new Error('quarantined finalize journal changed before recovery')
      }
      this.db
        .prepare(
          `UPDATE plugin_finalize_journals SET phase=?, quarantine_reason=NULL, updated_at=?
         WHERE plan_id=? AND phase='quarantined'`
        )
        .run(candidate.phase, Math.max(1, this.now()), candidate.journalId)
    })()
  }

  private requireRecord(journalId: string): FinalizeJournalRecord {
    const raw = this.readRaw(journalId)
    if (!raw) throw new Error('finalize journal does not exist')
    if (raw.phase === 'quarantined') {
      throw new Error('finalize journal is quarantined')
    }
    return parseRecord(raw)
  }

  private readRaw(journalId: string): RawFinalizeJournal | undefined {
    return this.db
      .prepare('SELECT * FROM plugin_finalize_journals WHERE plan_id=?')
      .get(journalId) as RawFinalizeJournal | undefined
  }
}

function parseQuarantinedMove(
  raw: RawFinalizeJournal
): FinalizeJournalRecord | null {
  if (
    raw.phase !== 'quarantined' ||
    !raw.quarantine_reason?.startsWith('compensation failed after ')
  )
    return null
  const value: unknown = JSON.parse(raw.plan_json)
  if (
    !value ||
    typeof value !== 'object' ||
    !('phase' in value) ||
    (value.phase !== 'prepared' && value.phase !== 'target_installed')
  )
    return null
  const record = {
    ...parseRecord({ ...raw, phase: value.phase }),
    quarantineReason: raw.quarantine_reason,
  }
  return isRetryableMoveQuarantine(record) ? record : null
}

function serializeRecord(record: FinalizeJournalRecord): string {
  return JSON.stringify(record)
}

function parseRecord(raw: RawFinalizeJournal): FinalizeJournalRecord {
  const value: unknown = JSON.parse(raw.plan_json)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('journal record is not an object')
  }
  const record = value as FinalizeJournalRecord
  if (record.journalId !== raw.plan_id || record.plan?.taskId !== raw.task_id) {
    throw new TypeError('journal identity columns do not match record')
  }
  if (record.phase !== raw.phase) {
    throw new TypeError('journal phase column does not match record')
  }
  if (
    record.publicationMode !== undefined &&
    record.publicationMode !== 'copy' &&
    record.publicationMode !== 'move'
  ) {
    throw new TypeError('journal publication mode is invalid')
  }
  if (
    record.publicationMode === 'move' &&
    (record.plan.replacement !== undefined ||
      finalizePathsEquivalent(record.plan.sourcePath, record.plan.targetPath))
  ) {
    throw new TypeError('journal move publication plan is invalid')
  }
  assertValidHookPlan(record.plan)
  validateIntents(record)
  const sourceIdentity = JSON.stringify(record.plan.sourceIdentity)
  if (sourceIdentity !== JSON.stringify(JSON.parse(raw.source_identity_json))) {
    throw new TypeError('journal source identity column does not match plan')
  }
  if (
    raw.target_identity_json !== null &&
    JSON.stringify(record.targetIdentity) !==
      JSON.stringify(JSON.parse(raw.target_identity_json))
  ) {
    throw new TypeError('journal target identity column does not match record')
  }
  return record
}

const fileIdentitySchema = z.object({
  kind: z.literal('file'),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  platformFileId: z.string().min(1),
})
const publicationIntentSchema = z
  .object({
    version: z.literal(1),
    method: z.literal('hard_link'),
    sourcePath: z.string(),
    identity: fileIdentitySchema,
  })
  .strict()
const isolationSchema = z
  .object({
    directory: z.string(),
    platformFileId: z.string().regex(/^\d+:\d+$/),
  })
  .strict()

function validateIntents(record: FinalizeJournalRecord): void {
  if (record.publicationIntent !== undefined) {
    const intent = publicationIntentSchema.parse(record.publicationIntent)
    const expectedPath =
      record.publicationMode === 'move'
        ? record.plan.sourcePath
        : record.privateTargetPath
    const expectedIdentity =
      record.publicationMode === 'move'
        ? record.plan.sourceIdentity
        : record.privateTargetIdentity
    if (
      !expectedPath ||
      !expectedIdentity ||
      intent.sourcePath !== expectedPath ||
      !artifactIdentityEquals(intent.identity, expectedIdentity) ||
      finalizePathsEquivalent(intent.sourcePath, record.plan.targetPath)
    ) {
      throw new TypeError(
        'journal publication intent does not match its installation source'
      )
    }
  }
  const removal = record.removalIntent
  if (removal?.isolation !== undefined) {
    const isolation = isolationSchema.parse(removal.isolation)
    if (
      !path.isAbsolute(isolation.directory) ||
      path.dirname(isolation.directory) !==
        path.dirname(removal.artifactPath) ||
      removal.quarantinePath !== path.join(isolation.directory, 'payload') ||
      removal.identity.kind !== 'file'
    ) {
      throw new TypeError('journal removal isolation is invalid')
    }
  }
}

function transitionAllowed(
  record: FinalizeJournalRecord,
  to: FinalizeJournalPhase
): boolean {
  const from = record.phase
  return (
    (from === 'prepared' &&
      (to === 'source_preserved' || to === 'target_staged')) ||
    (from === 'prepared' &&
      record.publicationMode === 'move' &&
      to === 'target_installed') ||
    (from === 'source_preserved' && to === 'target_staged') ||
    (from === 'target_staged' && to === 'target_installed') ||
    ((from === 'prepared' ||
      from === 'source_preserved' ||
      from === 'target_staged' ||
      from === 'target_installed') &&
      to === 'cleaned') ||
    (from === 'db_committed' && to === 'cleaned')
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
