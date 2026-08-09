// PluginStateStore — single source of truth for plugin runtime state.
//
// Spec §7 L2336-2348 — backing table:
//   plugin_state(plugin_id, enabled, last_error, error_count, installed_at,
//                last_activated_at). `status` is an internal field tracked
//                alongside the spec's columns.
//
// Spec §7 L2319-2333 — source-of-truth split:
//   `enabled` lives ONLY here. `appSettings.plugins[<id>]` carries the
//   plugin's user-config blob ONLY; never duplicate `enabled` there.
//   Touching `enabled` from a settings writer would race with `disable()` /
//   the circuit breaker and is forbidden.
import type { PluginStateRecord, PluginStatus } from '@shared/types/plugin'
import type Database from 'better-sqlite3'

interface Row {
  plugin_id: string
  enabled: number
  status: PluginStatus
  last_error: string | null
  error_count: number
  installed_at: number
  last_activated_at: number | null
}

export class PluginStateStore {
  constructor(private readonly db: Database.Database) {}

  upsert(rec: PluginStateRecord): void {
    this.db
      .prepare(
        `INSERT INTO plugin_state
            (plugin_id, enabled, status, last_error, error_count, installed_at, last_activated_at)
          VALUES
            (@pluginId, @enabled, @status, @lastError, @errorCount, @installedAt, @lastActivatedAt)
          ON CONFLICT(plugin_id) DO UPDATE SET
            enabled = excluded.enabled,
            status = excluded.status,
            last_error = excluded.last_error,
            error_count = excluded.error_count,
            installed_at = excluded.installed_at,
            last_activated_at = excluded.last_activated_at`
      )
      .run({
        pluginId: rec.pluginId,
        enabled: rec.enabled ? 1 : 0,
        status: rec.status,
        lastError: rec.lastError ?? null,
        errorCount: rec.errorCount,
        installedAt: rec.installedAt,
        lastActivatedAt: rec.lastActivatedAt ?? null,
      })
  }

  get(pluginId: string): PluginStateRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM plugin_state WHERE plugin_id = ?')
      .get(pluginId) as Row | undefined
    return row ? rowToRecord(row) : undefined
  }

  list(): PluginStateRecord[] {
    const rows = this.db.prepare('SELECT * FROM plugin_state').all() as Row[]
    return rows.map(rowToRecord)
  }

  setEnabled(pluginId: string, enabled: boolean): void {
    this.db
      .prepare(
        'UPDATE plugin_state SET enabled = ?, status = ? WHERE plugin_id = ?'
      )
      .run(enabled ? 1 : 0, enabled ? 'inactive' : 'disabled', pluginId)
  }

  setStatus(pluginId: string, status: PluginStatus): void {
    this.db
      .prepare('UPDATE plugin_state SET status = ? WHERE plugin_id = ?')
      .run(status, pluginId)
  }

  recordError(pluginId: string, message: string): void {
    this.db
      .prepare(
        `UPDATE plugin_state
           SET error_count = error_count + 1, last_error = ?, status = 'error'
         WHERE plugin_id = ?`
      )
      .run(message, pluginId)
  }

  clearError(pluginId: string): void {
    this.db
      .prepare(
        `UPDATE plugin_state
           SET error_count = 0, last_error = NULL, status = 'inactive'
         WHERE plugin_id = ?`
      )
      .run(pluginId)
  }

  markActivated(pluginId: string, ts: number): void {
    this.db
      .prepare(
        `UPDATE plugin_state
           SET last_activated_at = ?, status = 'active'
         WHERE plugin_id = ?`
      )
      .run(ts, pluginId)
  }

  remove(pluginId: string): void {
    this.db
      .prepare('DELETE FROM plugin_state WHERE plugin_id = ?')
      .run(pluginId)
  }
}

function rowToRecord(row: Row): PluginStateRecord {
  return {
    pluginId: row.plugin_id,
    enabled: row.enabled === 1,
    status: row.status,
    lastError: row.last_error ?? undefined,
    errorCount: row.error_count,
    installedAt: row.installed_at,
    lastActivatedAt: row.last_activated_at ?? undefined,
  }
}
