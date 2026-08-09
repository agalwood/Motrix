import type Database from 'better-sqlite3'
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

  setFinalizePath(p: string): void {
    this.finalizePath = p
  }

  get pendingFinalizePath(): string | undefined {
    return this.finalizePath
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
      const now = Date.now()
      for (const op of this.metaOps) {
        if (op.op === 'set') {
          const json = JSON.stringify(op.value)
          insertSql.run(
            taskId,
            op.pluginId,
            op.key,
            json,
            op.size ?? Buffer.byteLength(json),
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
