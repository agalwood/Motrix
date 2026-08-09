// Per-plugin key-value store backed by SQLite (better-sqlite3).
// Each value is JSON-serialized; binary is not supported at this layer.
// Access is scoped per pluginId — plugins cannot read each other's data.
//
// Versioning: every row carries a monotonic `version` integer.
//   - First `set` creates version 1.
//   - Subsequent `set` increments the version unconditionally (upsert).
//   - `compareAndSet` is the only conditional write primitive (I40 invariant).
//     expectedVersion=0 means "insert only if absent";
//     expectedVersion=N>0 means "update only when stored version equals N".
//
// Quota: 5 MB per plugin (default; overridable in constructor).
//   Enforced via a pre-flight SUM(size) check before every write.
//   `size` = Buffer.byteLength(json, 'utf8') for the incoming value.
//
// Schema bootstrap: call `ensureStorageSchema(db)` once at startup.
//   Task 18 factory (createElectronCapabilityHost / createServerCapabilityHost)
//   is responsible for calling this — NOT the Plan-A migrations/ directory.

import type Database from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

export function ensureStorageSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_storage (
      plugin_id  TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      size       INTEGER NOT NULL,
      version    INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_id, key)
    )
  `)
}

// ---------------------------------------------------------------------------
// Public result interfaces
// ---------------------------------------------------------------------------

export interface StorageGetResult {
  value: unknown
  version: number
}

export interface StorageSetResult {
  version: number
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFAULT_QUOTA = 5 << 20 // 5 MB

export class StorageError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'StorageError'
  }
}

/**
 * Serialize `value` to JSON.
 * Throws `plugin.storage.value_not_serializable` when:
 *  - the value is top-level `undefined`
 *  - JSON.stringify returns undefined (e.g. a plain function)
 *  - JSON.stringify throws (e.g. BigInt, class with throwing toJSON)
 */
function serialize(value: unknown): string {
  if (value === undefined) {
    throw new StorageError(
      'plugin.storage.value_not_serializable',
      'plugin.storage.value_not_serializable: undefined is not JSON-serializable'
    )
  }
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    throw new StorageError(
      'plugin.storage.value_not_serializable',
      'plugin.storage.value_not_serializable: value cannot be serialized to JSON'
    )
  }
  if (json === undefined) {
    throw new StorageError(
      'plugin.storage.value_not_serializable',
      'plugin.storage.value_not_serializable: value cannot be serialized to JSON'
    )
  }
  return json
}

// Escape LIKE special characters so prefix matching is literal.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

// ---------------------------------------------------------------------------
// StorageCapabilityHost
// ---------------------------------------------------------------------------

export class StorageCapabilityHost {
  private readonly db: Database.Database
  private readonly quotaBytes: number

  constructor(opts: { db: Database.Database; quotaBytes?: number }) {
    this.db = opts.db
    this.quotaBytes = opts.quotaBytes ?? DEFAULT_QUOTA
  }

  // -------------------------------------------------------------------------
  // Quota pre-flight
  // -------------------------------------------------------------------------

  private assertQuota(
    pluginId: string,
    key: string,
    projectedSize: number
  ): void {
    const row = this.db
      .prepare<[string], { total: number }>(
        'SELECT COALESCE(SUM(size), 0) AS total FROM plugin_storage WHERE plugin_id = ?'
      )
      .get(pluginId) ?? { total: 0 }

    const currentRow = this.db
      .prepare<[string, string], { size: number } | undefined>(
        'SELECT size FROM plugin_storage WHERE plugin_id = ? AND key = ?'
      )
      .get(pluginId, key)

    const currentSize = currentRow?.size ?? 0
    const projected = row.total - currentSize + projectedSize

    if (projected > this.quotaBytes) {
      throw new StorageError(
        'plugin.storage.quota_exceeded',
        `plugin.storage.quota_exceeded: projected usage ${projected} exceeds quota ${this.quotaBytes}`
      )
    }
  }

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------

  async get(pluginId: string, key: string): Promise<StorageGetResult> {
    const row = this.db
      .prepare<
        [string, string],
        { value: string; version: number } | undefined
      >(
        'SELECT value, version FROM plugin_storage WHERE plugin_id = ? AND key = ?'
      )
      .get(pluginId, key)

    if (!row) {
      return { value: undefined, version: 0 }
    }
    return {
      value: JSON.parse(row.value) as unknown,
      version: row.version,
    }
  }

  // -------------------------------------------------------------------------
  // set (unconditional upsert)
  // -------------------------------------------------------------------------

  async set(
    pluginId: string,
    key: string,
    value: unknown
  ): Promise<StorageSetResult> {
    const json = serialize(value)
    const size = Buffer.byteLength(json, 'utf8')
    this.assertQuota(pluginId, key, size)

    const now = Date.now()
    const row = this.db
      .prepare<
        [string, string, string, number, number],
        { version: number } | undefined
      >(
        `INSERT INTO plugin_storage (plugin_id, key, value, size, version, updated_at)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(plugin_id, key) DO UPDATE SET
           value = excluded.value,
           size = excluded.size,
           version = plugin_storage.version + 1,
           updated_at = excluded.updated_at
         RETURNING version`
      )
      .get(pluginId, key, json, size, now)

    // RETURNING always produces a row for an upsert — this path is unreachable.
    if (!row) throw new Error('storage.set: RETURNING produced no row')
    return { version: row.version }
  }

  // -------------------------------------------------------------------------
  // compareAndSet
  // -------------------------------------------------------------------------

  async compareAndSet(
    pluginId: string,
    key: string,
    expectedVersion: number,
    value: unknown
  ): Promise<StorageSetResult> {
    const json = serialize(value)
    const size = Buffer.byteLength(json, 'utf8')
    this.assertQuota(pluginId, key, size)

    const now = Date.now()

    if (expectedVersion === 0) {
      // Insert only if absent
      const row = this.db
        .prepare<
          [string, string, string, number, number],
          { version: number } | undefined
        >(
          `INSERT INTO plugin_storage (plugin_id, key, value, size, version, updated_at)
           VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT(plugin_id, key) DO NOTHING
           RETURNING version`
        )
        .get(pluginId, key, json, size, now)

      if (!row) {
        throw new StorageError(
          'plugin.storage.cas_mismatch',
          'plugin.storage.cas_mismatch: key already exists (expectedVersion=0)'
        )
      }
      return { version: row.version }
    }

    // Update only when stored version matches expectedVersion
    const row = this.db
      .prepare<
        [string, number, number, string, string, number],
        { version: number } | undefined
      >(
        `UPDATE plugin_storage
         SET value = ?, size = ?, version = version + 1, updated_at = ?
         WHERE plugin_id = ? AND key = ? AND version = ?
         RETURNING version`
      )
      .get(json, size, now, pluginId, key, expectedVersion)

    if (!row) {
      throw new StorageError(
        'plugin.storage.cas_mismatch',
        'plugin.storage.cas_mismatch: version mismatch or key not found'
      )
    }
    return { version: row.version }
  }

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  async delete(pluginId: string, key: string): Promise<{ deleted: boolean }> {
    const result = this.db
      .prepare<[string, string]>(
        'DELETE FROM plugin_storage WHERE plugin_id = ? AND key = ?'
      )
      .run(pluginId, key)

    return { deleted: result.changes > 0 }
  }

  // -------------------------------------------------------------------------
  // deleteAll (uninstall cascade — I14)
  // -------------------------------------------------------------------------

  // Called by PluginInstaller.uninstall to purge every row this plugin owns.
  async deleteAll(pluginId: string): Promise<{ deleted: number }> {
    const result = this.db
      .prepare<[string]>('DELETE FROM plugin_storage WHERE plugin_id = ?')
      .run(pluginId)
    return { deleted: result.changes }
  }

  // -------------------------------------------------------------------------
  // keys
  // -------------------------------------------------------------------------

  async keys(pluginId: string, prefix?: string): Promise<string[]> {
    if (prefix !== undefined) {
      const escaped = escapeLike(prefix)
      const rows = this.db
        .prepare<[string, string], { key: string }>(
          "SELECT key FROM plugin_storage WHERE plugin_id = ? AND key LIKE ? ESCAPE '\\'"
        )
        .all(pluginId, `${escaped}%`)
      return rows.map((r) => r.key)
    }

    const rows = this.db
      .prepare<[string], { key: string }>(
        'SELECT key FROM plugin_storage WHERE plugin_id = ?'
      )
      .all(pluginId)
    return rows.map((r) => r.key)
  }
}
