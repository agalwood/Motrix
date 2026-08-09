import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate, StaleSchemaError } from '.'
import { v1 } from './v1'
import { v2 } from './v2'
import { V3_SCHEMA_OBJECTS } from './v3'

const cleanupDirs: string[] = []

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function openMemory(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  return db
}

function insertParent(db: Database.Database, taskId = 'task-1'): void {
  db.prepare(
    `INSERT INTO tasks (
      motrix_id, name, task_type, created_at, updated_at
    ) VALUES (?, 'fixture', 'bt', 1, 1)`
  ).run(taskId)
}

function readVersion(db: Database.Database): number {
  return (
    db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
      version: number
    }
  ).version
}

function declareVersion(db: Database.Database, version: number): void {
  db.exec(
    `CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`
  )
  db.prepare(
    'INSERT INTO schema_version (version, applied_at) VALUES (?, 1)'
  ).run(version)
}

function expectCanonicalTaskSchemaError(db: Database.Database): void {
  let thrown: unknown
  try {
    migrate(db)
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(StaleSchemaError)
  expect((thrown as InstanceType<typeof StaleSchemaError>).reason).toBe(
    'canonical_task_columns_missing'
  )
}

function expectInheritedSchemaError(db: Database.Database): void {
  let thrown: unknown
  try {
    migrate(db)
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(StaleSchemaError)
  expect((thrown as InstanceType<typeof StaleSchemaError>).reason).toBe(
    'inherited_schema_missing'
  )
}

function rebuildTable(
  db: Database.Database,
  table: string,
  mutateSql: (sql: string) => string
): void {
  const tableSql = (
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get(table) as { sql: string }
  ).sql
  const indexes = db
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL
       ORDER BY name`
    )
    .all(table) as Array<{ sql: string }>

  db.exec(`DROP TABLE ${table}`)
  db.exec(mutateSql(tableSql))
  for (const index of indexes) {
    db.exec(index.sql)
  }
}

describe('migration v3', () => {
  it('migrates a fresh database to version 3 with the exact v3 objects', () => {
    const db = openMemory()
    migrate(db)

    expect(readVersion(db)).toBe(3)
    const names = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type IN ('table', 'index')
         ORDER BY name`
      )
      .all() as Array<{ name: string }>
    for (const object of V3_SCHEMA_OBJECTS) {
      expect(names.map((row) => row.name)).toContain(object.name)
    }
    expect(db.pragma('foreign_key_check')).toEqual([])
    db.close()
  })

  it('preserves a v1 parent, instance, and file across migrate-close-reopen', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'motrix-v3-migration-'))
    cleanupDirs.push(dir)
    const dbPath = path.join(dir, 'motrix.db')
    const first = new Database(dbPath)
    first.pragma('foreign_keys = ON')
    first.exec(
      `CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )`
    )
    first.transaction(() => {
      v1.up(first)
      first
        .prepare(
          'INSERT INTO schema_version (version, applied_at) VALUES (1, 1)'
        )
        .run()
      insertParent(first, 'survivor')
      first
        .prepare(
          `INSERT INTO task_instances (
            instance_id, motrix_id, phase, created_at, updated_at
          ) VALUES ('survivor-instance', 'survivor', 'bt_download', 1, 1)`
        )
        .run()
      first
        .prepare(
          `INSERT INTO task_files (
            motrix_id, file_index, path, size, selected
          ) VALUES ('survivor', 7, '/tmp/survivor', 123, 1)`
        )
        .run()
    })()

    migrate(first)
    first.close()

    const reopened = new Database(dbPath)
    reopened.pragma('foreign_keys = ON')
    expect(readVersion(reopened)).toBe(3)
    expect(
      reopened
        .prepare("SELECT motrix_id FROM tasks WHERE motrix_id = 'survivor'")
        .get()
    ).toEqual({ motrix_id: 'survivor' })
    expect(
      reopened
        .prepare(
          "SELECT instance_id FROM task_instances WHERE motrix_id = 'survivor'"
        )
        .get()
    ).toEqual({ instance_id: 'survivor-instance' })
    expect(
      reopened
        .prepare(
          "SELECT file_index FROM task_files WHERE motrix_id = 'survivor'"
        )
        .get()
    ).toEqual({ file_index: 7 })
    expect(reopened.pragma('foreign_key_check')).toEqual([])
    reopened.close()
  })

  it('accepts a legal declared v2 database before applying v3', () => {
    const db = openMemory()
    db.exec(
      `CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )`
    )
    db.transaction(() => {
      v1.up(db)
      v2.up(db)
      db.prepare(
        'INSERT INTO schema_version (version, applied_at) VALUES (1, 1), (2, 2)'
      ).run()
    })()

    expect(() => migrate(db)).not.toThrow()
    expect(readVersion(db)).toBe(3)
    db.close()
  })

  it('rejects a declared v1 database with a missing canonical task column', () => {
    const db = openMemory()
    v1.up(db)
    declareVersion(db, 1)
    db.exec('ALTER TABLE tasks DROP COLUMN source_meta')

    expectCanonicalTaskSchemaError(db)
    db.close()
  })

  it('rejects a declared v1 database with a missing canonical task index', () => {
    const db = openMemory()
    v1.up(db)
    declareVersion(db, 1)
    db.exec('DROP INDEX idx_tasks_info_hash')

    expectCanonicalTaskSchemaError(db)
    db.close()
  })

  it('rejects a declared v1 database with reordered task-instance columns', () => {
    const db = openMemory()
    v1.up(db)
    declareVersion(db, 1)
    rebuildTable(db, 'task_instances', (sql) =>
      sql.replace(
        `instance_id TEXT PRIMARY KEY,
        motrix_id TEXT NOT NULL`,
        `motrix_id TEXT NOT NULL,
        instance_id TEXT PRIMARY KEY`
      )
    )

    expectCanonicalTaskSchemaError(db)
    db.close()
  })

  it('v2 copies task-instance values by name instead of source position', () => {
    const db = openMemory()
    v1.up(db)
    insertParent(db, 'named-copy')
    rebuildTable(db, 'task_instances', (sql) =>
      sql.replace(
        `instance_id TEXT PRIMARY KEY,
        motrix_id TEXT NOT NULL`,
        `motrix_id TEXT NOT NULL,
        instance_id TEXT PRIMARY KEY`
      )
    )
    db.prepare(
      `INSERT INTO task_instances (
        instance_id, motrix_id, phase, created_at, updated_at
      ) VALUES ('named-instance', 'named-copy', 'bt_download', 1, 2)`
    ).run()

    db.transaction(() => v2.up(db))()

    expect(
      db
        .prepare(
          `SELECT instance_id, motrix_id, phase, created_at, updated_at
           FROM task_instances`
        )
        .get()
    ).toEqual({
      instance_id: 'named-instance',
      motrix_id: 'named-copy',
      phase: 'bt_download',
      created_at: 1,
      updated_at: 2,
    })
    expect(db.pragma('foreign_key_check')).toEqual([])
    db.close()
  })

  it('rejects a declared v1 database with a corrupt task-file constraint', () => {
    const db = openMemory()
    v1.up(db)
    declareVersion(db, 1)
    rebuildTable(db, 'task_files', (sql) =>
      sql.replace('CHECK (size >= 0)', 'CHECK (size >= -1)')
    )

    expectCanonicalTaskSchemaError(db)
    db.close()
  })

  it('rejects a declared v1 database with a missing transfer-total column', () => {
    const db = openMemory()
    v1.up(db)
    declareVersion(db, 1)
    db.exec('ALTER TABLE transfer_totals DROP COLUMN upload_bytes')

    expectInheritedSchemaError(db)
    db.close()
  })

  it('rejects a declared v2 database with a weakened transfer-bucket constraint', () => {
    const db = openMemory()
    v1.up(db)
    v2.up(db)
    declareVersion(db, 2)
    rebuildTable(db, 'transfer_buckets', (sql) =>
      sql.replace('upload_bytes >= 0', 'upload_bytes >= -1')
    )

    expectInheritedSchemaError(db)
    db.close()
  })

  it.each(['tasks', 'task_instances', 'task_files'])(
    'rejects a declared v3 database with corrupt inherited %s schema',
    (table) => {
      const db = openMemory()
      migrate(db)
      db.exec(`ALTER TABLE ${table} ADD COLUMN unexpected TEXT`)

      expectCanonicalTaskSchemaError(db)
      db.close()
    }
  )

  it.each([
    [
      'a transfer-total column',
      'ALTER TABLE transfer_totals DROP COLUMN upload_bytes',
    ],
    ['the plugin-state table', 'DROP TABLE plugin_state'],
    [
      'the exact schema-version shape',
      'ALTER TABLE schema_version ADD COLUMN unexpected TEXT',
    ],
  ])('rejects a declared v3 database missing %s', (_label, sql) => {
    const db = openMemory()
    migrate(db)
    db.exec(sql)

    expectInheritedSchemaError(db)
    db.close()
  })

  it('rejects a declared v3 database with a missing canonical object', () => {
    const db = openMemory()
    migrate(db)
    db.exec('DROP TABLE task_transfer_samples')

    expect(() => migrate(db)).toThrow(StaleSchemaError)
    db.close()
  })

  it('rejects a declared v3 database missing the notifications table', () => {
    const db = openMemory()
    migrate(db)
    db.exec('DROP TABLE notifications')

    let caught: unknown
    try {
      migrate(db)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(StaleSchemaError)
    expect(String(caught)).toMatch(/notification/i)
    db.close()
  })

  it('enforces strict bounds, kinds, statuses, and bounded detail', () => {
    const db = openMemory()
    migrate(db)
    insertParent(db)
    const insertSummary = db.prepare(
      `INSERT INTO task_inspector_activity (
        motrix_id, tracking_started_at, updated_at
      ) VALUES (?, ?, ?)`
    )
    expect(() => insertSummary.run('', 1, 1)).toThrow()
    expect(() => insertSummary.run('task-1', 0, 1)).toThrow()
    insertSummary.run('task-1', 1, 1)

    const insertEvent = db.prepare(
      `INSERT INTO task_history_events (
        motrix_id, event_ordinal, event_key, kind, from_status, to_status,
        occurred_at, accuracy, error_code, error_message
      ) VALUES ('task-1', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    expect(() =>
      insertEvent.run(
        0,
        'bad-ordinal',
        'added',
        null,
        'queued',
        1,
        'exact',
        null,
        null
      )
    ).toThrow()
    expect(() =>
      insertEvent.run(1, '', 'added', null, 'queued', 1, 'exact', null, null)
    ).toThrow()
    expect(() =>
      insertEvent.run(
        1,
        'bad-kind',
        'unknown',
        null,
        'queued',
        1,
        'exact',
        null,
        null
      )
    ).toThrow()
    expect(() =>
      insertEvent.run(
        1,
        'bad-status',
        'added',
        null,
        'unknown',
        1,
        'exact',
        null,
        null
      )
    ).toThrow()
    expect(() =>
      insertEvent.run(
        1,
        'bad-detail',
        'failed',
        'downloading',
        'error',
        1,
        'exact',
        'x'.repeat(129),
        null
      )
    ).toThrow()

    const insertSample = db.prepare(
      `INSERT INTO task_transfer_samples (
        motrix_id, sampled_at, download_bps, upload_bps, flags
      ) VALUES ('task-1', ?, ?, ?, ?)`
    )
    expect(() => insertSample.run(0, 0, 0, 0)).toThrow()
    expect(() => insertSample.run(1, -1, 0, 0)).toThrow()
    expect(() => insertSample.run(1, 0, 0, 2_147_483_648)).toThrow()
    db.close()
  })

  it('cascades task-owned activity while retaining global accounting', () => {
    const db = openMemory()
    migrate(db)
    insertParent(db)
    db.prepare(
      `INSERT INTO task_inspector_activity (
        motrix_id, tracking_started_at, updated_at
      ) VALUES ('task-1', 1, 1)`
    ).run()
    db.prepare(
      `INSERT INTO task_history_events (
        motrix_id, event_ordinal, event_key, kind, to_status, occurred_at
      ) VALUES ('task-1', 1, 'added', 'added', 'queued', 1)`
    ).run()
    db.prepare(
      `INSERT INTO task_transfer_samples (
        motrix_id, sampled_at, download_bps, upload_bps
      ) VALUES ('task-1', 1, 2, 3)`
    ).run()
    db.prepare(
      `INSERT INTO task_activity_events (
        motrix_id, kind, occurred_at, accuracy
      ) VALUES ('task-1', 'submitted', 1, 'exact')`
    ).run()
    db.prepare(
      `INSERT INTO transfer_buckets (
        bucket_start_ms, download_bytes, upload_bytes, updated_at
      ) VALUES (0, 1, 2, 1)`
    ).run()

    db.prepare("DELETE FROM tasks WHERE motrix_id = 'task-1'").run()

    for (const table of [
      'task_inspector_activity',
      'task_history_events',
      'task_transfer_samples',
    ]) {
      expect(
        (
          db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count: number
          }
        ).count
      ).toBe(0)
    }
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM task_activity_events')
          .get() as {
          count: number
        }
      ).count
    ).toBe(1)
    expect(
      (
        db.prepare('SELECT COUNT(*) AS count FROM transfer_buckets').get() as {
          count: number
        }
      ).count
    ).toBe(1)
    db.close()
  })

  it('round-trips Failed detail and a recovered observed-state anchor', () => {
    const db = openMemory()
    migrate(db)
    insertParent(db)
    const insert = db.prepare(
      `INSERT INTO task_history_events (
        motrix_id, event_ordinal, event_key, kind, from_status, to_status,
        occurred_at, accuracy, error_code, error_message
      ) VALUES ('task-1', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    insert.run(
      1,
      'failed-1',
      'failed',
      'downloading',
      'error',
      100,
      'exact',
      'E_NETWORK',
      'connection lost'
    )
    insert.run(
      2,
      'observed-2',
      'observed_state',
      null,
      'paused',
      101,
      'recovered',
      null,
      null
    )

    expect(
      db
        .prepare(
          `SELECT
             event_ordinal, kind, accuracy, error_code, error_message
           FROM task_history_events
           WHERE motrix_id = 'task-1'
           ORDER BY event_ordinal`
        )
        .all()
    ).toEqual([
      {
        event_ordinal: 1,
        kind: 'failed',
        accuracy: 'exact',
        error_code: 'E_NETWORK',
        error_message: 'connection lost',
      },
      {
        event_ordinal: 2,
        kind: 'observed_state',
        accuracy: 'recovered',
        error_code: null,
        error_message: null,
      },
    ])
    db.close()
  })

  it('accepts distinct same-millisecond keys and exposes indexed task plans', () => {
    const db = openMemory()
    migrate(db)
    insertParent(db)
    db.prepare(
      `INSERT INTO task_inspector_activity (
        motrix_id, tracking_started_at, updated_at
      ) VALUES ('task-1', 1, 1)`
    ).run()
    const event = db.prepare(
      `INSERT INTO task_history_events (
        motrix_id, event_ordinal, event_key, kind, from_status, to_status,
        occurred_at
      ) VALUES ('task-1', ?, ?, ?, ?, ?, 100)`
    )
    event.run(1, 'pause-1', 'paused', 'downloading', 'paused')
    event.run(2, 'resume-1', 'resumed', 'paused', 'downloading')
    expect(() =>
      event.run(3, 'pause-1', 'paused', 'downloading', 'paused')
    ).toThrow()

    db.prepare(
      `INSERT INTO task_transfer_samples (
        motrix_id, sampled_at, download_bps, upload_bps
      ) VALUES ('task-1', 100, 1, 2), ('task-1', 101, 2, 3)`
    ).run()

    const eventPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT * FROM task_history_events
         WHERE motrix_id = ?
         ORDER BY event_ordinal`
      )
      .all('task-1') as Array<{ detail: string }>
    expect(
      eventPlan.some((row) =>
        /USING INDEX sqlite_autoindex_task_history_events_2/i.test(row.detail)
      )
    ).toBe(true)
    const eventPrunePlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT event_id FROM task_history_events
         WHERE motrix_id = ?
         ORDER BY event_ordinal DESC
         LIMIT 1`
      )
      .all('task-1') as Array<{ detail: string }>
    expect(
      eventPrunePlan.some((row) =>
        /USING (COVERING )?INDEX sqlite_autoindex_task_history_events_2/i.test(
          row.detail
        )
      )
    ).toBe(true)
    const samplePlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT * FROM task_transfer_samples
         WHERE motrix_id = ?
         ORDER BY sampled_at`
      )
      .all('task-1') as Array<{ detail: string }>
    expect(
      samplePlan.some((row) => /USING PRIMARY KEY.*motrix_id/i.test(row.detail))
    ).toBe(true)
    const latestSamplePlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT * FROM task_transfer_samples
         WHERE motrix_id = ?
         ORDER BY sampled_at DESC
         LIMIT 1`
      )
      .all('task-1') as Array<{ detail: string }>
    expect(
      latestSamplePlan.some((row) =>
        /USING PRIMARY KEY.*motrix_id/i.test(row.detail)
      )
    ).toBe(true)
    db.close()
  })
})
