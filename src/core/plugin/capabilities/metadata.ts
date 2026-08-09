// Per-plugin per-task metadata store backed by SQLite (better-sqlite3).
// Each value is JSON-serialized; binary is not supported at this layer.
// Access is scoped per (taskId, pluginId) pair — plugins cannot read each
// other's metadata for the same task.
//
// Quota: 64 KB per (plugin_id, task_id) pair (default; overridable in
// constructor). Enforced via a pre-flight SUM(size) check before every write.
// `size` = Buffer.byteLength(json, 'utf8') for the incoming value.
//
// Schema bootstrap: call `ensureMetadataSchema(db)` once at startup.
//   Task 18 factory (createElectronCapabilityHost / createServerCapabilityHost)
//   is responsible for calling this.
//   `deleteAllForTask` is intended to be called when a download task is
//   removed, so metadata is cleaned up across all plugins.
//   Plan C hook context integration will wire taskId from hook invocation.

import type Database from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

export function ensureMetadataSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_task_metadata (
      task_id    TEXT NOT NULL,
      plugin_id  TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      size       INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, plugin_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_plugin_task_metadata_task
      ON plugin_task_metadata(task_id);
  `)
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class MetadataError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'MetadataError'
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFAULT_QUOTA = 64 << 10 // 64 KB

/**
 * Serialize `value` to JSON.
 * Throws `plugin.metadata.value_not_serializable` when:
 *  - the value is top-level `undefined`
 *  - JSON.stringify returns undefined (e.g. a plain function)
 *  - JSON.stringify throws (e.g. BigInt, class with throwing toJSON)
 */
function serialize(value: unknown): string {
  if (value === undefined) {
    throw new MetadataError(
      'plugin.metadata.value_not_serializable',
      'plugin.metadata.value_not_serializable: undefined is not JSON-serializable'
    )
  }
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    throw new MetadataError(
      'plugin.metadata.value_not_serializable',
      'plugin.metadata.value_not_serializable: value cannot be serialized to JSON'
    )
  }
  if (json === undefined) {
    throw new MetadataError(
      'plugin.metadata.value_not_serializable',
      'plugin.metadata.value_not_serializable: value cannot be serialized to JSON'
    )
  }
  return json
}

// ---------------------------------------------------------------------------
// MetadataCapabilityHost
// ---------------------------------------------------------------------------

export class MetadataCapabilityHost {
  private readonly db: Database.Database
  private readonly perPluginPerTaskBytes: number

  constructor(opts: {
    db: Database.Database
    perPluginPerTaskBytes?: number
  }) {
    this.db = opts.db
    this.perPluginPerTaskBytes = opts.perPluginPerTaskBytes ?? DEFAULT_QUOTA
  }

  // -------------------------------------------------------------------------
  // Quota pre-flight
  // -------------------------------------------------------------------------

  private assertQuota(
    taskId: string,
    pluginId: string,
    key: string,
    projectedSize: number
  ): void {
    const totRow = this.db
      .prepare<[string, string], { total: number }>(
        `SELECT COALESCE(SUM(size), 0) AS total
         FROM plugin_task_metadata
         WHERE task_id = ? AND plugin_id = ?`
      )
      .get(taskId, pluginId) ?? { total: 0 }

    const curRow = this.db
      .prepare<[string, string, string], { size: number } | undefined>(
        `SELECT size FROM plugin_task_metadata
         WHERE task_id = ? AND plugin_id = ? AND key = ?`
      )
      .get(taskId, pluginId, key)

    const currentSize = curRow?.size ?? 0
    const projected = totRow.total - currentSize + projectedSize

    if (projected > this.perPluginPerTaskBytes) {
      throw new MetadataError(
        'plugin.metadata.quota_exceeded',
        `plugin.metadata.quota_exceeded: projected usage ${projected} exceeds quota ${this.perPluginPerTaskBytes}`
      )
    }
  }

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------

  async get(taskId: string, pluginId: string, key: string): Promise<unknown> {
    const row = this.db
      .prepare<[string, string, string], { value: string } | undefined>(
        `SELECT value FROM plugin_task_metadata
         WHERE task_id = ? AND plugin_id = ? AND key = ?`
      )
      .get(taskId, pluginId, key)

    if (!row) return undefined
    return JSON.parse(row.value) as unknown
  }

  // -------------------------------------------------------------------------
  // has
  // -------------------------------------------------------------------------

  async has(taskId: string, pluginId: string, key: string): Promise<boolean> {
    const row = this.db
      .prepare<[string, string, string], { found: number } | undefined>(
        `SELECT 1 AS found FROM plugin_task_metadata
         WHERE task_id = ? AND plugin_id = ? AND key = ?`
      )
      .get(taskId, pluginId, key)

    return row !== undefined
  }

  // -------------------------------------------------------------------------
  // getAll
  // -------------------------------------------------------------------------

  async getAll(
    taskId: string,
    pluginId: string
  ): Promise<Record<string, unknown>> {
    const rows = this.db
      .prepare<[string, string], { key: string; value: string }>(
        `SELECT key, value FROM plugin_task_metadata
         WHERE task_id = ? AND plugin_id = ?`
      )
      .all(taskId, pluginId)

    return Object.fromEntries(
      rows.map((r) => [r.key, JSON.parse(r.value) as unknown])
    )
  }

  // -------------------------------------------------------------------------
  // keys
  // -------------------------------------------------------------------------

  async keys(taskId: string, pluginId: string): Promise<string[]> {
    const rows = this.db
      .prepare<[string, string], { key: string }>(
        `SELECT key FROM plugin_task_metadata
         WHERE task_id = ? AND plugin_id = ?
         ORDER BY key ASC`
      )
      .all(taskId, pluginId)

    return rows.map((r) => r.key)
  }

  // -------------------------------------------------------------------------
  // set (unconditional upsert)
  // -------------------------------------------------------------------------

  async set(
    taskId: string,
    pluginId: string,
    key: string,
    value: unknown
  ): Promise<void> {
    const json = serialize(value)
    const size = Buffer.byteLength(json, 'utf8')
    this.assertQuota(taskId, pluginId, key, size)

    const now = Date.now()
    this.db
      .prepare<[string, string, string, string, number, number]>(
        `INSERT INTO plugin_task_metadata
           (task_id, plugin_id, key, value, size, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (task_id, plugin_id, key) DO UPDATE SET
           value      = excluded.value,
           size       = excluded.size,
           updated_at = excluded.updated_at`
      )
      .run(taskId, pluginId, key, json, size, now)
  }

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  async delete(
    taskId: string,
    pluginId: string,
    key: string
  ): Promise<{ deleted: boolean }> {
    const result = this.db
      .prepare<[string, string, string]>(
        `DELETE FROM plugin_task_metadata
         WHERE task_id = ? AND plugin_id = ? AND key = ?`
      )
      .run(taskId, pluginId, key)

    return { deleted: result.changes > 0 }
  }

  // -------------------------------------------------------------------------
  // deleteAllForTask
  // -------------------------------------------------------------------------

  async deleteAllForTask(taskId: string): Promise<{ deleted: number }> {
    const result = this.db
      .prepare<[string]>(`DELETE FROM plugin_task_metadata WHERE task_id = ?`)
      .run(taskId)

    return { deleted: result.changes }
  }

  // -------------------------------------------------------------------------
  // deleteAllForPlugin (uninstall cascade — I14)
  // -------------------------------------------------------------------------

  // Called by PluginInstaller.uninstall: drops every row written by this
  // plugin across all tasks.
  async deleteAllForPlugin(pluginId: string): Promise<{ deleted: number }> {
    const result = this.db
      .prepare<[string]>(`DELETE FROM plugin_task_metadata WHERE plugin_id = ?`)
      .run(pluginId)
    return { deleted: result.changes }
  }
}
