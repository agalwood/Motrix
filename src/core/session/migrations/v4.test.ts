import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate, StaleSchemaError } from '.'
import { v1 } from './v1'
import { v2 } from './v2'
import { v3 } from './v3'
import { V4_SCHEMA_OBJECTS } from './v4'

function openMemory(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  return db
}

function readVersion(db: Database.Database): number {
  return (
    db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
      version: number
    }
  ).version
}

function createDeclaredV3(db: Database.Database): void {
  db.exec(`CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`)
  db.transaction(() => {
    v1.up(db)
    v2.up(db)
    v3.up(db)
    db.prepare(
      'INSERT INTO schema_version (version, applied_at) VALUES (1, 1), (2, 2), (3, 3)'
    ).run()
  })()
}

describe('migration v4', () => {
  it('creates every exact plugin Hook runtime object on a fresh database', () => {
    const db = openMemory()
    migrate(db)

    expect(readVersion(db)).toBe(4)
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type IN ('table', 'index')
         ORDER BY name`
      )
      .all() as Array<{ name: string }>
    const names = new Set(rows.map((row) => row.name))
    for (const object of V4_SCHEMA_OBJECTS) {
      expect(names.has(object.name), object.name).toBe(true)
    }
    expect(names.has('plugin_lifecycle_journals')).toBe(false)
    expect(db.pragma('foreign_key_check')).toEqual([])
    db.close()
  })

  it('upgrades a declared v3 database without changing its task rows', () => {
    const db = openMemory()
    createDeclaredV3(db)
    db.prepare(
      `INSERT INTO tasks (
        motrix_id, name, task_type, created_at, updated_at
      ) VALUES ('survivor', 'fixture', 'bt', 1, 1)`
    ).run()

    migrate(db)

    expect(readVersion(db)).toBe(4)
    expect(
      db.prepare("SELECT name FROM tasks WHERE motrix_id = 'survivor'").get()
    ).toEqual({ name: 'fixture' })
    expect(db.pragma('foreign_key_check')).toEqual([])
    db.close()
  })

  it('rolls back every partial v4 object when a late create fails', () => {
    const db = openMemory()
    createDeclaredV3(db)
    db.exec('CREATE TABLE plugin_post_quota_ledger (unexpected TEXT)')

    expect(() => migrate(db)).toThrow()
    expect(readVersion(db)).toBe(3)
    expect(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='plugin_finalize_journals'"
        )
        .get()
    ).toBeUndefined()
    db.close()
  })

  it('enforces finalize phase/quarantine consistency', () => {
    const db = openMemory()
    migrate(db)
    const insert = db.prepare(`
      INSERT INTO plugin_finalize_journals (
        plan_id, task_id, phase, plan_json, source_identity_json,
        target_identity_json, quarantine_reason, created_at, updated_at
      ) VALUES (?, ?, ?, '{}', '{}', NULL, ?, 1, 1)
    `)

    expect(() =>
      insert.run('plan-bad', 'task-bad', 'quarantined', null)
    ).toThrow()
    expect(() =>
      insert.run('plan-ok', 'task-ok', 'quarantined', 'identity_changed')
    ).not.toThrow()
    db.close()
  })

  it('enforces delivery lease, terminal reason, and digest constraints', () => {
    const db = openMemory()
    migrate(db)
    const insert = db.prepare(`
      INSERT INTO plugin_post_deliveries (
        delivery_id, deduplication_key, occurrence_id, hook, task_id, occurred_at, plugin_id, plugin_version,
        executable_digest, created_generation, effective_permissions_json,
        required_permissions_json, payload_json, payload_bytes, reserved_bytes, status,
        attempt_count, next_attempt_at, lease_owner, lease_expires_at,
        permanent_reason, created_at, updated_at, delivered_at
      ) VALUES (
        @deliveryId, @deduplicationKey, 'occ-1', 'afterComplete', 'task-1', 1, 'plugin.example', '1.0.0',
        @digest, 1, '[]', '[]', '{}', 2, 518, @status,
        0, 1, @leaseOwner, @leaseExpiresAt, @permanentReason, 1, 1, @deliveredAt
      )
    `)
    const digest = 'a'.repeat(64)

    expect(() =>
      insert.run({
        deliveryId: 'delivery-pending',
        deduplicationKey: 'b'.repeat(64),
        digest,
        status: 'pending',
        leaseOwner: null,
        leaseExpiresAt: null,
        permanentReason: null,
        deliveredAt: null,
      })
    ).not.toThrow()
    expect(() =>
      insert.run({
        deliveryId: 'delivery-bad-lease',
        deduplicationKey: 'c'.repeat(64),
        digest,
        status: 'delivering',
        leaseOwner: null,
        leaseExpiresAt: null,
        permanentReason: null,
        deliveredAt: null,
      })
    ).toThrow()
    expect(() =>
      insert.run({
        deliveryId: 'delivery-bad-digest',
        deduplicationKey: 'd'.repeat(64),
        digest: 'not-a-digest',
        status: 'pending',
        leaseOwner: null,
        leaseExpiresAt: null,
        permanentReason: null,
        deliveredAt: null,
      })
    ).toThrow()
    db.close()
  })

  it('persists only structurally valid durable circuit-breaker states', () => {
    const db = openMemory()
    migrate(db)
    const insert = db.prepare(`
      INSERT INTO plugin_post_breakers (
        plugin_id, state, failure_count, window_started_at, open_until,
        probe_token, probe_lease_expires_at, updated_at
      ) VALUES (?, ?, 0, NULL, ?, ?, ?, 1)
    `)

    expect(() =>
      insert.run('plugin.closed', 'closed', null, null, null)
    ).not.toThrow()
    expect(() =>
      insert.run('plugin.open', 'open', 5_000, null, null)
    ).not.toThrow()
    expect(() =>
      insert.run('plugin.bad', 'half_open', null, null, null)
    ).toThrow()
    expect(() =>
      insert.run('plugin.probe', 'half_open', null, 'probe-1', 5_000)
    ).not.toThrow()
    db.close()
  })

  it('rejects a declared v4 database with a weakened Hook table', () => {
    const db = openMemory()
    migrate(db)
    db.exec('ALTER TABLE plugin_post_deliveries ADD COLUMN unexpected TEXT')

    let thrown: unknown
    try {
      migrate(db)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(StaleSchemaError)
    expect((thrown as StaleSchemaError).reason).toBe(
      'plugin_hook_schema_missing'
    )
    db.close()
  })
})
