import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { CreateDownloadParams } from '@core/engine/engine-adapter'
import { newEngineTaskId, newTaskId } from '@core/lib/ids'
import type { SecretStore } from '@core/plugin/capabilities/secret-store'
import {
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
} from '@shared/types/task'
import type Database from 'better-sqlite3'
import { durableSqliteWrite } from './durable-sqlite-write'
import type { MotrixDatabase, TaskWithInstances } from './motrix-database'

/** Storage failures keep their original errors. The transport adapter maps
 * these three expected protocol decisions to its SDK's typed error codes. */
export class HandoffJournalRefusal extends Error {
  constructor(
    readonly reason: 'instance-changed' | 'payload-conflict' | 'not-accepting'
  ) {
    super(
      {
        'instance-changed': 'Handoff instance mismatch',
        'payload-conflict': 'Handoff payload conflict',
        'not-accepting': 'New handoffs disabled',
      }[reason]
    )
  }
}

/** principal is derived from the authenticated installation, never the wire payload. */
export interface HandoffKey {
  principal: string
  instanceId: string
  operationId: string
}
export type HandoffStatus =
  | { state: 'not-found' | 'aborted' | 'expired' }
  | {
      state: 'prepared'
      taskId: string
      payloadHash: string
      expiresAt: number
    }
  | { state: 'committed'; taskId: string; payloadHash: string }

interface Row {
  state: 'prepared' | 'committed' | 'aborted' | 'expired'
  task_id: string | null
  payload_hash: string | null
  engine_id: string | null
  expires_at: number | null
  save_dir: string | null
  sealed: string | null
}
export interface Activation {
  taskId: string
  engineId: string
  saveDir: string
  canonicalPayload: string
  engineRequest?: CreateDownloadParams
}
const digest = (payload: string) =>
  createHash('sha256').update(payload, 'utf8').digest('hex')
const TABLES = ['handoff_instance', 'handoff_operations', 'handoff_activations']
/** Restore must fence outbox owners even when the host cannot open its secret store. */
export function readHandoffActivationOwners(
  storage: MotrixDatabase
): Map<string, string> {
  const db = storage.database
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN (?,?,?)"
    )
    .all(...TABLES)
  if (!tables.length) return new Map()
  if (tables.length !== TABLES.length)
    throw new Error('Incomplete handoff database')
  const rows = db
    .prepare('SELECT task_id, engine_id FROM handoff_activations')
    .all() as { task_id: string; engine_id: string }[]
  return new Map(rows.map((row) => [row.task_id, row.engine_id]))
}
const schema = `
  CREATE TABLE handoff_instance (singleton INTEGER PRIMARY KEY CHECK(singleton=1), instance_id TEXT NOT NULL);
  CREATE TABLE handoff_operations (
    principal TEXT NOT NULL, operation_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','committed','expired','aborted')),
    task_id TEXT UNIQUE, engine_id TEXT UNIQUE, payload_hash TEXT, expires_at INTEGER, save_dir TEXT, sealed TEXT,
    PRIMARY KEY(principal,operation_id),
    CHECK(state!='prepared' OR (task_id IS NOT NULL AND engine_id IS NOT NULL AND payload_hash IS NOT NULL AND expires_at IS NOT NULL AND save_dir IS NOT NULL AND sealed IS NOT NULL))
  );
  CREATE INDEX handoff_expiry ON handoff_operations(expires_at) WHERE state='prepared';
  CREATE TABLE handoff_activations (
    task_id TEXT PRIMARY KEY REFERENCES tasks(motrix_id) ON DELETE CASCADE,
    engine_id TEXT NOT NULL UNIQUE, save_dir TEXT NOT NULL, sealed TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','dispatching'))
  );
`
function result(row?: Row): HandoffStatus {
  if (!row) return { state: 'not-found' }
  if (
    row.state === 'prepared' &&
    row.task_id &&
    row.payload_hash &&
    row.expires_at !== null
  )
    return {
      state: 'prepared',
      taskId: row.task_id,
      payloadHash: row.payload_hash,
      expiresAt: row.expires_at,
    }
  if (row.state === 'committed' && row.task_id && row.payload_hash)
    return {
      state: 'committed',
      taskId: row.task_id,
      payloadHash: row.payload_hash,
    }
  if (row.state === 'aborted' || row.state === 'expired')
    return { state: row.state }
  throw new Error('Incomplete handoff record')
}
/** Opened only by hosts opting into local handoff integration. Mutating callbacks
 * are synchronous SQLite work. No engine or source I/O runs in a transaction. */
export class DownloadHandoffJournal {
  readonly instanceId: string
  private readonly db: Database.Database
  constructor(
    private readonly storage: MotrixDatabase,
    private readonly secrets: SecretStore,
    private readonly acceptingNew: () => boolean,
    private readonly now: () => number = Date.now,
    private readonly capacity = 100_000
  ) {
    const db = storage.database
    this.db = db
    this.instanceId = this.write(() => {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN (?,?,?)"
        )
        .all(...TABLES)
      if (tables.length === 0) {
        db.exec(schema)
        db.prepare('INSERT INTO handoff_instance VALUES(1,?)').run(randomUUID())
      } else if (tables.length !== TABLES.length)
        throw new Error('Incomplete handoff database')
      return this.generation()
    })
  }
  get acceptingNewOperations() {
    return this.acceptingNew() && this.secrets.available()
  }
  private write<T>(fn: () => T) {
    return durableSqliteWrite(this.db, fn, 'handoff', true)
  }
  private generation() {
    const row = this.db
      .prepare('SELECT instance_id FROM handoff_instance WHERE singleton=1')
      .get() as { instance_id: string } | undefined
    if (!row?.instance_id) throw new Error('Missing handoff instance')
    return row.instance_id
  }
  private assertInstance(expected = this.instanceId) {
    if (expected !== this.instanceId || expected !== this.generation())
      throw new HandoffJournalRefusal('instance-changed')
  }
  private read(key: HandoffKey, hash?: string) {
    this.assertInstance(key.instanceId)
    if (!key.principal || !key.operationId)
      throw new Error('Missing handoff key')
    this.db
      .prepare(
        "UPDATE handoff_operations SET state='expired', sealed=NULL,save_dir=NULL,expires_at=NULL WHERE state='prepared' AND expires_at<=?"
      )
      .run(this.now())
    const row = this.db
      .prepare(
        'SELECT * FROM handoff_operations WHERE principal=? AND operation_id=?'
      )
      .get(key.principal, key.operationId) as Row | undefined
    if (hash !== undefined && row?.payload_hash && row.payload_hash !== hash)
      throw new HandoffJournalRefusal('payload-conflict')
    return row
  }
  private reserveCapacity() {
    const { n } = this.db
      .prepare('SELECT COUNT(*) AS n FROM handoff_operations')
      .get() as { n: number }
    if (n >= this.capacity) throw new Error('Handoff ledger is full')
  }
  status(key: HandoffKey) {
    return this.write(() => result(this.read(key)))
  }
  async prepare(
    key: HandoffKey,
    canonicalPayload: string,
    directory: string | (() => Promise<string>),
    ttlMs: number,
    authorized: () => boolean = () => true
  ) {
    const hash = digest(canonicalPayload)
    const previous = this.write(() => result(this.read(key, hash)))
    if (previous.state !== 'not-found') return previous
    if (!this.acceptingNew()) throw new HandoffJournalRefusal('not-accepting')
    const saveDir =
      typeof directory === 'string' ? directory : await directory()
    if (
      !isAbsolute(saveDir) ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1 ||
      ttlMs > 120000
    )
      throw new Error('Invalid handoff preparation')
    const sealed = await this.secrets.encrypt(canonicalPayload)
    return this.write(() => {
      if (!authorized()) throw new Error('Handoff authorization changed')
      const stored = this.read(key, hash)
      if (stored) return result(stored)
      if (!this.acceptingNew()) throw new HandoffJournalRefusal('not-accepting')
      this.reserveCapacity()
      this.db
        .prepare(
          "INSERT INTO handoff_operations(principal,operation_id,state,task_id,engine_id,payload_hash,expires_at,save_dir,sealed) VALUES(?,?,'prepared',?,?,?,?,?,?)"
        )
        .run(
          key.principal,
          key.operationId,
          newTaskId(),
          newEngineTaskId(undefined, 'handoff'),
          hash,
          this.now() + ttlMs,
          saveDir,
          sealed
        )
      return result(this.read(key))
    })
  }
  abort(key: HandoffKey) {
    return this.write(() => {
      const row = this.read(key)
      if (!row) {
        this.reserveCapacity()
        this.db
          .prepare(
            "INSERT INTO handoff_operations(principal,operation_id,state) VALUES(?,?,'aborted')"
          )
          .run(key.principal, key.operationId)
      } else if (row.state === 'prepared') {
        this.db
          .prepare(
            "UPDATE handoff_operations SET state='aborted',sealed=NULL,save_dir=NULL,expires_at=NULL WHERE principal=? AND operation_id=?"
          )
          .run(key.principal, key.operationId)
      }
      return result(this.read(key))
    })
  }
  async withPrepared(
    key: HandoffKey,
    hash: string,
    plan: (intent: Activation) => Promise<HandoffStatus>
  ): Promise<HandoffStatus> {
    const row = this.write(() => this.read(key, hash))
    if (row?.state !== 'prepared') return result(row)
    if (!row.sealed || !row.task_id || !row.engine_id || !row.save_dir)
      throw new Error('Incomplete handoff reservation')
    const canonicalPayload = await this.secrets.decrypt(row.sealed)
    if (digest(canonicalPayload) !== hash)
      throw new Error('Stored handoff payload mismatch')
    return plan({
      taskId: row.task_id,
      engineId: row.engine_id,
      saveDir: row.save_dir,
      canonicalPayload,
    })
  }
  async commit(
    key: HandoffKey,
    hash: string,
    materialize: (intent: Activation) => TaskWithInstances,
    engineRequest?: CreateDownloadParams
  ) {
    const row = this.write(() => this.read(key, hash))
    if (row?.state !== 'prepared') return result(row)
    if (!row.sealed) throw new Error('Missing prepared payload')
    const canonicalPayload = await this.secrets.decrypt(row.sealed)
    if (digest(canonicalPayload) !== hash)
      throw new Error('Stored handoff payload mismatch')
    const launch = engineRequest
      ? 'request:' +
        (await this.secrets.encrypt(
          JSON.stringify({ canonicalPayload, engineRequest })
        ))
      : row.sealed
    return this.write(() => {
      const current = this.read(key, hash)
      if (current?.state !== 'prepared') return result(current)
      const {
        task_id: taskId,
        engine_id: engineId,
        save_dir: saveDir,
        sealed,
      } = current
      if (!taskId || !engineId || !saveDir || !sealed)
        throw new Error('Incomplete handoff reservation')
      // materialize must revalidate the currently permitted frozen directory.
      const snapshot = materialize({
        taskId,
        engineId,
        saveDir,
        canonicalPayload,
      })
      if (
        snapshot.task.kind !== TaskKind.Direct ||
        snapshot.task.taskType !== TaskType.Http ||
        snapshot.task.source !== 'bridge' ||
        snapshot.task.aggStatus !== TaskStatus.Queued ||
        snapshot.instances[0]?.phase !== TaskInstancePhase.HttpDownload ||
        snapshot.instances[0]?.status !== TaskStatus.Queued ||
        snapshot.task.motrixId !== taskId ||
        snapshot.task.saveDir !== saveDir ||
        snapshot.instances.length !== 1 ||
        snapshot.instances[0]?.gid !== engineId ||
        snapshot.instances[0]?.motrixId !== taskId
      )
        throw new Error('Handoff task does not match reservation')
      this.storage.insertReservedTask(snapshot)
      this.db
        .prepare("INSERT INTO handoff_activations VALUES(?,?,?,?,'pending')")
        .run(taskId, engineId, saveDir, launch)
      this.db
        .prepare(
          "UPDATE handoff_operations SET state='committed',sealed=NULL,save_dir=NULL,expires_at=NULL WHERE principal=? AND operation_id=?"
        )
        .run(key.principal, key.operationId)
      return result(this.read(key))
    })
  }

  /** Unknown dispatch outcomes remain recorded. A second worker may reconcile
   * the reserved engine ID, but cannot issue another create for an in-flight ID. */
  async activate(
    taskId: string,
    engine: {
      contains: (id: string) => Promise<boolean>
      beforeStart?: (intent: Activation) => Promise<void>
      start: (intent: Activation) => Promise<string>
    }
  ): Promise<'activated' | 'unresolved' | 'absent'> {
    const job = this.write(() => {
      this.assertInstance()
      const row = this.db
        .prepare(
          'SELECT a.*, o.payload_hash FROM handoff_activations a JOIN handoff_operations o USING(task_id) WHERE task_id=?'
        )
        .get(taskId) as
        | {
            engine_id: string
            save_dir: string
            sealed: string
            payload_hash: string
            state: 'pending' | 'dispatching'
          }
        | undefined
      return row
    })
    if (!job) return 'absent'
    const exists = await engine.contains(job.engine_id)
    if (exists && job.state === 'pending') return 'unresolved'
    if (!exists) {
      if (job.state === 'dispatching') return 'unresolved'
      const planned = job.sealed.startsWith('request:')
      const clear = await this.secrets.decrypt(
        planned ? job.sealed.slice(8) : job.sealed
      )
      const { canonicalPayload, engineRequest } = planned
        ? (JSON.parse(clear) as Pick<
            Activation,
            'canonicalPayload' | 'engineRequest'
          >)
        : { canonicalPayload: clear, engineRequest: undefined }
      if (digest(canonicalPayload) !== job.payload_hash)
        throw new Error('Stored activation payload mismatch')
      const intent = {
        taskId,
        engineId: job.engine_id,
        saveDir: job.save_dir,
        canonicalPayload,
        ...(engineRequest ? { engineRequest } : {}),
      }
      await engine.beforeStart?.(intent)
      const claim = this.write(() => {
        this.assertInstance()
        return (
          this.db
            .prepare(
              "UPDATE handoff_activations SET state='dispatching' WHERE task_id=? AND engine_id=? AND state='pending'"
            )
            .run(taskId, job.engine_id).changes === 1
        )
      })
      if (!claim) return 'unresolved'
      if ((await engine.start(intent)) !== job.engine_id)
        throw new Error('Unexpected engine identity')
    }
    this.write(() => {
      this.assertInstance()
      this.db
        .prepare(
          'DELETE FROM handoff_activations WHERE task_id=? AND engine_id=?'
        )
        .run(taskId, job.engine_id)
    })
    return 'activated'
  }
  pendingActivations(): string[] {
    this.assertInstance()
    return (
      this.db
        .prepare('SELECT task_id FROM handoff_activations ORDER BY rowid')
        .all() as { task_id: string }[]
    ).map((row) => row.task_id)
  }
}
