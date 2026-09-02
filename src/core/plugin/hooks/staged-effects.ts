import type Database from 'better-sqlite3'
import {
  DEFAULT_METADATA_QUOTA_BYTES,
  MetadataError,
  serializeMetadataValue,
} from '../capabilities/metadata'
import type { RoleBand } from './role-band'
import type { FfmpegStaging } from './staging-dir'

export interface StagedHttpPatch {
  uris?: string[]
  filename?: string
  connections?: number
  headers?: Array<{ name: string; value: string }>
  proxy?: string
}

export interface StagedMetadataOp {
  pluginId: string
  op: 'set' | 'delete'
  key: string
  value?: unknown
  size?: number
}

export class StagedEffectStore {
  private httpPatches: Array<{
    pluginId: string
    role: RoleBand
    patch: StagedHttpPatch
  }> = []
  private metaOps: StagedMetadataOp[] = []
  private finalizePath: string | undefined
  private stagings: Map<string, FfmpegStaging> = new Map()

  appendHttp(pluginId: string, role: RoleBand, patch: StagedHttpPatch): void {
    // Shallow-clone at the boundary so later caller mutations don't leak in.
    this.httpPatches.push({ pluginId, role, patch: { ...patch } })
  }

  appendMeta(op: StagedMetadataOp): void {
    this.metaOps.push(op)
  }

  /**
   * Register the plugin's ffmpeg staging. Unlike appendHttp/appendMeta,
   * each plugin may have only ONE staging — a second call from the same
   * pluginId replaces the first. Insertion order across plugins is
   * preserved for takeAllStagings (Map.entries semantics).
   */
  appendStaging(pluginId: string, staging: FfmpegStaging): void {
    this.stagings.set(pluginId, staging)
  }

  takeAllStagings(): Array<{ pluginId: string; staging: FfmpegStaging }> {
    const out = [...this.stagings.entries()].map(([pluginId, staging]) => ({
      pluginId,
      staging,
    }))
    this.stagings.clear()
    return out
  }

  allMetadataOps(): readonly StagedMetadataOp[] {
    return this.metaOps.map((operation) => ({ ...operation }))
  }

  setFinalizePath(p: string): void {
    this.finalizePath = p
  }

  get pendingFinalizePath(): string | undefined {
    return this.finalizePath
  }

  /** Restore the working target after a fail-open plugin is isolated. */
  restoreFinalizePath(path: string | undefined): void {
    this.finalizePath = path
  }

  /** Merged view of uris/filename/connections: later entries win. */
  latestStagedFields(): Partial<StagedHttpPatch> {
    const out: Partial<StagedHttpPatch> = {}
    for (const e of this.httpPatches) {
      if (e.patch.uris !== undefined) out.uris = e.patch.uris
      if (e.patch.filename !== undefined) out.filename = e.patch.filename
      if (e.patch.connections !== undefined)
        out.connections = e.patch.connections
    }
    return out
  }

  allHttpPatches(): ReadonlyArray<{
    pluginId: string
    role: RoleBand
    patch: StagedHttpPatch
  }> {
    return this.httpPatches
  }

  /**
   * Atomically commits all staged metadata ops and the caller-supplied `tx`
   * inside a single SQLite transaction. If `tx` throws, nothing is written.
   */
  commitMetadata(db: Database.Database, taskId: string, tx: () => void): void {
    const insertSql = db.prepare(
      `INSERT INTO plugin_task_metadata
         (task_id, plugin_id, key, value, size, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, plugin_id, key) DO UPDATE SET
         value=excluded.value,
         size=excluded.size,
         updated_at=excluded.updated_at`
    )
    const delSql = db.prepare(
      'DELETE FROM plugin_task_metadata WHERE task_id=? AND plugin_id=? AND key=?'
    )

    db.transaction(() => {
      tx()
      const serialized = validateStagedMetadataQuota(db, taskId, this.metaOps)
      const now = Date.now()
      for (const [index, op] of this.metaOps.entries()) {
        if (op.op === 'set') {
          const value = serialized.get(index)
          if (!value) {
            throw new MetadataError(
              'plugin.metadata.value_not_serializable',
              'plugin.metadata.value_not_serializable: staged value is missing'
            )
          }
          insertSql.run(
            taskId,
            op.pluginId,
            op.key,
            value.json,
            value.size,
            now
          )
        } else {
          delSql.run(taskId, op.pluginId, op.key)
        }
      }
    })()
  }

  /** Clears all in-memory state; does not touch the database. */
  discard(): void {
    this.httpPatches = []
    this.metaOps = []
    this.finalizePath = undefined
    this.stagings.clear()
  }

  /**
   * Plan C fail-open isolation — drop every staged contribution from the named
   * plugin. Called by the HookOrchestrator when an enrich/audit plugin throws
   * mid-chain so its partial effects are not committed alongside the
   * succeeding plugins'. The finalize path is intentionally NOT cleared here:
   * it is only ever set by resolve/post-process plugins (audit/enrich cannot
   * touch it per the matrix), so removing one of their meta/http stages should
   * not roll back a separate plugin's finalize decision.
   */
  removeFromPlugin(pluginId: string): void {
    this.httpPatches = this.httpPatches.filter((e) => e.pluginId !== pluginId)
    this.metaOps = this.metaOps.filter((o) => o.pluginId !== pluginId)
    this.stagings.delete(pluginId)
  }
}

interface MetadataUsage {
  total: number
  keys: Map<string, number>
}

/**
 * Apply staged operations to an in-memory projection of the transactional DB
 * state. This is the same replacement-aware 64 KiB rule enforced by
 * MetadataCapabilityHost, but evaluated across the whole ordered Hook batch
 * before the first staged row is persisted.
 */
function validateStagedMetadataQuota(
  db: Database.Database,
  taskId: string,
  operations: readonly StagedMetadataOp[]
): Map<number, { json: string; size: number }> {
  const selectUsage = db.prepare<
    [string, string],
    { key: string; size: number }
  >(
    `SELECT key, size
       FROM plugin_task_metadata
      WHERE task_id = ? AND plugin_id = ?`
  )
  const usageByPlugin = new Map<string, MetadataUsage>()
  const serialized = new Map<number, { json: string; size: number }>()

  const usageFor = (pluginId: string): MetadataUsage => {
    const existing = usageByPlugin.get(pluginId)
    if (existing) return existing
    const keys = new Map(
      selectUsage
        .all(taskId, pluginId)
        .map((row) => [row.key, row.size] as const)
    )
    const usage = {
      total: [...keys.values()].reduce((sum, size) => sum + size, 0),
      keys,
    }
    usageByPlugin.set(pluginId, usage)
    return usage
  }

  for (const [index, operation] of operations.entries()) {
    const usage = usageFor(operation.pluginId)
    const currentSize = usage.keys.get(operation.key) ?? 0
    if (operation.op === 'delete') {
      usage.total -= currentSize
      usage.keys.delete(operation.key)
      continue
    }

    const json = serializeMetadataValue(operation.value)
    const size = Buffer.byteLength(json, 'utf8')
    const projected = usage.total - currentSize + size
    if (projected > DEFAULT_METADATA_QUOTA_BYTES) {
      throw new MetadataError(
        'plugin.metadata.quota_exceeded',
        `plugin.metadata.quota_exceeded: projected usage ${projected} exceeds quota ${DEFAULT_METADATA_QUOTA_BYTES}`
      )
    }
    usage.total = projected
    usage.keys.set(operation.key, size)
    serialized.set(index, { json, size })
  }

  return serialized
}
