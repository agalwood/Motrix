import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { v1 } from './v1'
import { v2 } from './v2'

function freshDatabase(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.transaction(() => v1.up(db))()
  return db
}

describe('migration v1 (final schema)', () => {
  it('creates task, plugin, transfer, and activity tables without legacy tables', () => {
    const db = freshDatabase()
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as Array<{ name: string }>
    const names = tables.map((t) => t.name)

    expect(names).toContain('tasks')
    expect(names).toContain('task_instances')
    expect(names).toContain('task_files')
    expect(names).toContain('plugin_state')
    expect(names).toContain('transfer_totals')
    expect(names).toContain('transfer_buckets')
    expect(names).toContain('task_activity_meta')
    expect(names).toContain('task_activity_events')
    expect(names).not.toContain('task_metadata')

    db.close()
  })

  it('creates canonical type and terminal history columns', () => {
    const db = freshDatabase()
    const columns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{
      name: string
      notnull: number
    }>
    const byName = new Map(columns.map((column) => [column.name, column]))

    expect(byName.get('task_type')?.notnull).toBe(1)
    expect(byName.get('finished_at')?.notnull).toBe(0)
    expect(byName.get('error_message')?.notnull).toBe(0)
    expect(byName.get('error_code')?.notnull).toBe(0)

    const schema = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'"
      )
      .get() as { sql: string }
    for (const taskType of ['http', 'ftp', 'bt', 'magnet', 'metalink']) {
      expect(schema.sql).toContain(`'${taskType}'`)
    }

    db.close()
  })

  it('v2 rebuild keeps canonical column order and terminal values', () => {
    const db = freshDatabase()
    db.prepare(
      `INSERT INTO tasks (
        motrix_id, name, kind, task_type, priority,
        created_at, updated_at, final_path, final_name,
        total_bytes, downloaded_bytes, size_when_done, file_count,
        is_private, trackers, piece_length, agg_status,
        finished_at, error_message, error_code,
        uploaded_bytes_baseline, source
      ) VALUES (
        'm-terminal', 'failed', 'direct', 'metalink', 0,
        1, 2, '', '', 10, 5, 10, 1,
        0, '[]', 0, 'error',
        1234, 'network failed', 'DL_NETWORK_ERROR',
        0, 'user'
      )`
    ).run()
    const before = (
      db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
    ).map((column) => column.name)

    db.transaction(() => v2.up(db))()

    const after = (
      db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
    ).map((column) => column.name)
    expect(after).toEqual(before)
    expect(
      db
        .prepare(
          `SELECT task_type, finished_at, error_message, error_code
           FROM tasks WHERE motrix_id = 'm-terminal'`
        )
        .get()
    ).toEqual({
      task_type: 'metalink',
      finished_at: 1234,
      error_message: 'network failed',
      error_code: 'DL_NETWORK_ERROR',
    })
    expect(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_activity_events'"
        )
        .get()
    ).toEqual({ 1: 1 })

    db.close()
  })

  it('v2 rebuild preserves task instances and files with foreign keys enabled', () => {
    const db = freshDatabase()
    db.prepare(
      `INSERT INTO tasks (
        motrix_id, name, task_type, created_at, updated_at
      ) VALUES ('m-children', 'children', 'bt', 1, 1)`
    ).run()
    db.prepare(
      `INSERT INTO task_instances (
        instance_id, motrix_id, phase, created_at, updated_at
      ) VALUES ('i-children', 'm-children', 'bt_download', 1, 1)`
    ).run()
    db.prepare(
      `INSERT INTO task_files (
        motrix_id, file_index, path, size, selected
      ) VALUES ('m-children', 1, '/tmp/file', 42, 1)`
    ).run()

    db.transaction(() => v2.up(db))()

    expect(
      db
        .prepare(
          "SELECT instance_id, motrix_id FROM task_instances WHERE motrix_id = 'm-children'"
        )
        .get()
    ).toEqual({ instance_id: 'i-children', motrix_id: 'm-children' })
    expect(
      db
        .prepare(
          "SELECT file_index, path, size, selected FROM task_files WHERE motrix_id = 'm-children'"
        )
        .get()
    ).toEqual({ file_index: 1, path: '/tmp/file', size: 42, selected: 1 })
    expect(db.pragma('foreign_key_check')).toEqual([])

    db.close()
  })

  it('initializes stable activity metadata and the time-first index', () => {
    const before = Date.now()
    const db = freshDatabase()
    const after = Date.now()
    const readMeta = () =>
      db
        .prepare(
          `SELECT generation, tracking_started_at, revision, coverage_gap_at
           FROM task_activity_meta
           WHERE id = 1`
        )
        .get() as {
        generation: string
        tracking_started_at: number
        revision: number
        coverage_gap_at: number | null
      }

    const first = readMeta()
    expect(first.generation).toMatch(/^[0-9a-f-]+$/)
    expect(first.tracking_started_at).toBeGreaterThanOrEqual(before)
    expect(first.tracking_started_at).toBeLessThanOrEqual(after)
    expect(first.revision).toBe(0)
    expect(first.coverage_gap_at).toBeNull()
    expect(readMeta()).toEqual(first)

    const indexColumns = db
      .prepare('PRAGMA index_info(idx_task_activity_time)')
      .all() as Array<{ name: string }>
    expect(indexColumns.map((column) => column.name)).toEqual([
      'occurred_at',
      'kind',
      'accuracy',
    ])

    db.close()
  })

  it('enforces activity idempotency and value constraints', () => {
    const db = freshDatabase()
    const insert = db.prepare(
      `INSERT INTO task_activity_events (
        motrix_id,
        kind,
        occurred_at,
        accuracy
      ) VALUES (?, ?, ?, ?)`
    )
    insert.run('task-1', 'submitted', 1, 'exact')

    expect(() => insert.run('task-1', 'submitted', 2, 'exact')).toThrow(
      /UNIQUE/i
    )
    expect(() => insert.run('task-2', 'unknown', 1, 'exact')).toThrow(/CHECK/i)
    expect(() => insert.run('task-3', 'submitted', 1, 'approximate')).toThrow(
      /CHECK/i
    )
    expect(() => insert.run('task-4', 'submitted', 0, 'exact')).toThrow(
      /CHECK/i
    )

    insert.run('task-1', 'download_completed', 2, 'recovered')
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM task_activity_events').get()
    ).toEqual({ count: 2 })

    db.close()
  })

  it('keeps task activity after the task row is deleted', () => {
    const db = freshDatabase()
    db.prepare(
      `INSERT INTO tasks (
        motrix_id, name, kind, task_type, priority,
        created_at, updated_at, final_path, final_name,
        total_bytes, downloaded_bytes, size_when_done, file_count,
        is_private, trackers, piece_length, agg_status,
        uploaded_bytes_baseline, source
      ) VALUES (
        'historical', 'name', 'direct', 'http', 0,
        1, 1, '', '', 0, 0, 0, 0,
        0, '[]', 0, 'completed', 0, 'user'
      )`
    ).run()
    db.prepare(
      `INSERT INTO task_activity_events (
        motrix_id, kind, occurred_at, accuracy
      ) VALUES ('historical', 'submitted', 1, 'exact')`
    ).run()

    db.prepare("DELETE FROM tasks WHERE motrix_id = 'historical'").run()

    expect(
      db
        .prepare(
          "SELECT motrix_id FROM task_activity_events WHERE motrix_id = 'historical'"
        )
        .get()
    ).toEqual({ motrix_id: 'historical' })
    expect(
      db.prepare('PRAGMA foreign_key_list(task_activity_events)').all()
    ).toEqual([])

    db.close()
  })

  it('creates expected indexes on tasks and task_instances', () => {
    const db = freshDatabase()
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('tasks','task_instances')"
      )
      .all() as Array<{ name: string }>
    const names = indexes.map((i) => i.name)

    expect(names).toContain('idx_tasks_info_hash')
    expect(names).toContain('idx_tasks_status_created')
    expect(names).toContain('idx_task_instances_motrix_id')
    expect(names).toContain('idx_task_instances_gid')
    expect(names).toContain('idx_task_instances_uri_hash')
    expect(names).toContain('idx_task_instances_phase_status')

    db.close()
  })

  it('inserting a task + instance + files succeeds under foreign_keys=ON', () => {
    const db = freshDatabase()
    db.prepare(
      `INSERT INTO tasks (
        motrix_id, name, kind, task_type, priority,
        created_at, updated_at,
        final_path, final_name,
        total_bytes, downloaded_bytes, size_when_done, file_count,
        is_private, trackers, piece_length,
        agg_status, uploaded_bytes_baseline, source
      ) VALUES (
        'm-1', 'video.mp4', 'direct', 'http', 0,
        1700000000, 1700000001,
        '/Downloads', 'video.mp4',
        0, 0, 0, 1,
        0, '[]', 0,
        'queued', 0, 'user'
      )`
    ).run()
    db.prepare(
      `INSERT INTO task_instances (
        instance_id, motrix_id, gid, phase, status,
        created_at, updated_at
      ) VALUES (
        'i-1', 'm-1', 'g-1', 'http_download', 'queued',
        1700000000, 1700000001
      )`
    ).run()
    db.prepare(
      'INSERT INTO task_files (motrix_id, file_index, path, size, selected) VALUES (?, ?, ?, ?, ?)'
    ).run('m-1', 0, '/Downloads/video.mp4', 0, 1)

    const rows = db.prepare('SELECT * FROM task_files').all()
    expect(rows).toHaveLength(1)

    db.close()
  })

  it('DELETE FROM tasks cascades to task_instances and task_files', () => {
    const db = freshDatabase()
    db.prepare(
      `INSERT INTO tasks (motrix_id, name, kind, task_type, priority, created_at, updated_at, final_path, final_name, total_bytes, downloaded_bytes, size_when_done, file_count, is_private, trackers, piece_length, agg_status, uploaded_bytes_baseline, source)
       VALUES ('m-cascade', 'name', 'direct', 'http', 0, 1, 1, '', '', 0, 0, 0, 0, 0, '[]', 0, 'queued', 0, 'user')`
    ).run()
    db.prepare(
      `INSERT INTO task_instances (instance_id, motrix_id, gid, phase, status, created_at, updated_at)
       VALUES ('i-cascade', 'm-cascade', 'g-cascade', 'http_download', 'queued', 1, 1)`
    ).run()
    db.prepare(
      'INSERT INTO task_files (motrix_id, file_index, path, size, selected) VALUES (?, ?, ?, ?, ?)'
    ).run('m-cascade', 0, '/Downloads/a.bin', 100, 1)

    db.prepare('DELETE FROM tasks WHERE motrix_id = ?').run('m-cascade')

    expect(
      db
        .prepare('SELECT * FROM task_instances WHERE motrix_id = ?')
        .all('m-cascade')
    ).toEqual([])
    expect(
      db
        .prepare('SELECT * FROM task_files WHERE motrix_id = ?')
        .all('m-cascade')
    ).toEqual([])

    db.close()
  })

  it('rejects task_instances with unknown phase', () => {
    const db = freshDatabase()
    db.prepare(
      `INSERT INTO tasks (motrix_id, name, kind, task_type, priority, created_at, updated_at, final_path, final_name, total_bytes, downloaded_bytes, size_when_done, file_count, is_private, trackers, piece_length, agg_status, uploaded_bytes_baseline, source)
       VALUES ('m-x', 'x', 'direct', 'http', 0, 1, 1, '', '', 0, 0, 0, 0, 0, '[]', 0, 'queued', 0, 'user')`
    ).run()

    expect(() =>
      db
        .prepare(
          `INSERT INTO task_instances (instance_id, motrix_id, gid, phase, status, created_at, updated_at)
           VALUES ('i-bad', 'm-x', 'g-x', 'not_a_real_phase', 'queued', 1, 1)`
        )
        .run()
    ).toThrow(/CHECK/i)

    db.close()
  })

  it('rejects tasks with unknown kind', () => {
    const db = freshDatabase()
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (motrix_id, name, kind, task_type, priority, created_at, updated_at, final_path, final_name, total_bytes, downloaded_bytes, size_when_done, file_count, is_private, trackers, piece_length, agg_status, uploaded_bytes_baseline, source)
           VALUES ('m-bad-kind', 'x', 'imaginary_kind', 'http', 0, 1, 1, '', '', 0, 0, 0, 0, 0, '[]', 0, 'queued', 0, 'user')`
        )
        .run()
    ).toThrow(/CHECK/i)

    db.close()
  })

  it('post-migration foreign_key_check returns no violations', () => {
    const db = freshDatabase()
    const violations = db.prepare('PRAGMA foreign_key_check').all() as unknown[]
    expect(violations).toEqual([])
    db.close()
  })

  it('keeps transfer statistics independent from task foreign keys', () => {
    const db = freshDatabase()
    const totalsForeignKeys = db
      .prepare('PRAGMA foreign_key_list(transfer_totals)')
      .all()
    const bucketsForeignKeys = db
      .prepare('PRAGMA foreign_key_list(transfer_buckets)')
      .all()

    expect(totalsForeignKeys).toEqual([])
    expect(bucketsForeignKeys).toEqual([])

    db.close()
  })

  it('rejects negative transfer byte counts', () => {
    const db = freshDatabase()

    expect(() =>
      db
        .prepare(
          `INSERT INTO transfer_totals (
            id, download_bytes, upload_bytes, tracking_started_at
          ) VALUES (1, -1, 0, 0)`
        )
        .run()
    ).toThrow(/CHECK/i)

    expect(() =>
      db
        .prepare(
          `INSERT INTO transfer_buckets (
            bucket_start_ms, download_bytes, upload_bytes, updated_at
          ) VALUES (0, 0, -1, 0)`
        )
        .run()
    ).toThrow(/CHECK/i)

    db.close()
  })

  it('rejects SQLite integer overflow instead of coercing byte totals to REAL', () => {
    const db = freshDatabase()
    const maxInt64 = 9_223_372_036_854_775_807n

    db.prepare(
      `INSERT INTO transfer_totals (
        id, download_bytes, upload_bytes, tracking_started_at
      ) VALUES (1, ?, 0, 0)`
    ).run(maxInt64)

    expect(() =>
      db
        .prepare(
          `UPDATE transfer_totals
           SET download_bytes = download_bytes + 1
           WHERE id = 1`
        )
        .run()
    ).toThrow(/CHECK/i)

    const row = db
      .prepare(
        `SELECT download_bytes
         FROM transfer_totals
         WHERE id = 1`
      )
      .safeIntegers()
      .get() as { download_bytes: bigint }
    expect(row.download_bytes).toBe(maxInt64)

    db.close()
  })
})

describe('migrate() schema guard (Codex finding #7)', () => {
  it('fails fast with SchemaVersionTooNewError when schema_version > 1', async () => {
    const { migrate, SchemaVersionTooNewError } = await import('.')
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')

    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_version (version, applied_at) VALUES (6, 0);
      CREATE TABLE task_metadata (motrix_id TEXT PRIMARY KEY);
    `)

    expect(() => migrate(db)).toThrow(SchemaVersionTooNewError)

    const tasksExists = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'"
      )
      .get()
    expect(tasksExists).toBeUndefined()

    db.close()
  })

  it('is a noop on a second migrate() call after the chain has been applied', async () => {
    const { migrate } = await import('.')
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db)
    db.prepare(
      `INSERT INTO task_activity_events (
        motrix_id,
        kind,
        occurred_at,
        accuracy
      ) VALUES ('existing-task', 'download_completed', 42, 'exact')`
    ).run()
    db.prepare(
      `UPDATE task_activity_meta
       SET revision = 7, coverage_gap_at = 41
       WHERE id = 1`
    ).run()
    const activityBefore = {
      meta: db.prepare('SELECT * FROM task_activity_meta').get(),
      events: db
        .prepare('SELECT * FROM task_activity_events ORDER BY motrix_id, kind')
        .all(),
    }

    expect(() => migrate(db)).not.toThrow()
    expect(() => db.transaction(() => migrate(db))()).not.toThrow()
    expect({
      meta: db.prepare('SELECT * FROM task_activity_meta').get(),
      events: db
        .prepare('SELECT * FROM task_activity_events ORDER BY motrix_id, kind')
        .all(),
    }).toEqual(activityBefore)

    // After the first call: v1 + v2 + v3 applied (chain length grows as
    // new migrations are added). Second call observes
    // schema_version == HIGHEST_KNOWN_VERSION and does nothing.
    const rows = db
      .prepare('SELECT version FROM schema_version ORDER BY version')
      .all() as Array<{ version: number }>
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3])

    db.close()
  })

  it('applies the full migration chain on a fresh DB (no schema_version table yet)', async () => {
    const { migrate } = await import('.')
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')

    expect(() => migrate(db)).not.toThrow()

    const rows = db
      .prepare('SELECT version FROM schema_version ORDER BY version')
      .all() as Array<{ version: number }>
    // v1 is the Plan A baseline, v2 widens task statuses, and v3 adds
    // task-owned Inspector Activity persistence. All apply on a fresh DB.
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3])

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'tasks',
        'task_instances',
        'task_files',
        'plugin_state',
        'transfer_totals',
        'transfer_buckets',
        'task_inspector_activity',
        'task_history_events',
        'task_transfer_samples',
      ])
    )

    db.close()
  })

  it('fails fast with StaleSchemaError when schema_version=1 but legacy task_metadata is present (Codex finding #8)', async () => {
    const { migrate, StaleSchemaError } = await import('.')
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')

    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_version (version, applied_at) VALUES (1, 0);
      CREATE TABLE task_metadata (motrix_id TEXT PRIMARY KEY);
    `)

    expect(() => migrate(db)).toThrow(StaleSchemaError)

    db.close()
  })

  it('fails fast with StaleSchemaError when schema_version=1 but tasks table is missing', async () => {
    const { migrate, StaleSchemaError } = await import('.')
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')

    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_version (version, applied_at) VALUES (1, 0);
    `)

    expect(() => migrate(db)).toThrow(StaleSchemaError)

    db.close()
  })

  it('fails fast when a versioned database lacks canonical transfer tables', async () => {
    const { migrate, StaleSchemaError } = await import('.')
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')

    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_version (version, applied_at) VALUES (2, 0);
      CREATE TABLE tasks (
        motrix_id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL,
        finished_at INTEGER,
        error_message TEXT,
        error_code TEXT,
        error_detail_key TEXT,
        error_detail_params TEXT,
        diagnosis_revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE task_instances (instance_id TEXT PRIMARY KEY);
    `)

    let thrown: unknown
    try {
      migrate(db)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(StaleSchemaError)
    expect((thrown as InstanceType<typeof StaleSchemaError>).reason).toBe(
      'transfer_tables_missing'
    )

    db.close()
  })

  it('fails fast when a versioned database lacks canonical task columns', async () => {
    const { migrate, StaleSchemaError } = await import('.')
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')

    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_version (version, applied_at) VALUES (2, 0);
      CREATE TABLE tasks (motrix_id TEXT PRIMARY KEY);
      CREATE TABLE task_instances (instance_id TEXT PRIMARY KEY);
      CREATE TABLE transfer_totals (id INTEGER PRIMARY KEY);
      CREATE TABLE transfer_buckets (bucket_start_ms INTEGER PRIMARY KEY);
    `)

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
    expect((thrown as Error).message).toContain('task_type')

    db.close()
  })

  it.each([
    ['activity tables', 'DROP TABLE task_activity_events'],
    [
      'activity columns',
      `DROP TABLE task_activity_meta;
       CREATE TABLE task_activity_meta (id INTEGER PRIMARY KEY)`,
    ],
    ['the time-first activity index', 'DROP INDEX idx_task_activity_time'],
    [
      'a full time-first activity index',
      `DROP INDEX idx_task_activity_time;
       CREATE INDEX idx_task_activity_time
         ON task_activity_events(occurred_at, kind, accuracy)
         WHERE kind = 'submitted'`,
    ],
    [
      'a non-unique time-first activity index',
      `DROP INDEX idx_task_activity_time;
       CREATE UNIQUE INDEX idx_task_activity_time
         ON task_activity_events(occurred_at, kind, accuracy)`,
    ],
    [
      'only the canonical activity uniqueness constraint',
      `CREATE UNIQUE INDEX idx_task_activity_unexpected_unique
         ON task_activity_events(occurred_at)`,
    ],
    [
      'a history-preserving activity ledger',
      `DROP TABLE task_activity_events;
       CREATE TABLE task_activity_events (
         motrix_id TEXT NOT NULL,
         kind TEXT NOT NULL
           CHECK (kind IN ('submitted', 'download_completed')),
         occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
         accuracy TEXT NOT NULL DEFAULT 'exact'
           CHECK (accuracy IN ('exact', 'recovered')),
         PRIMARY KEY (motrix_id, kind),
         FOREIGN KEY (motrix_id) REFERENCES tasks(motrix_id) ON DELETE CASCADE
       ) WITHOUT ROWID;
       CREATE INDEX idx_task_activity_time
         ON task_activity_events(occurred_at, kind, accuracy)`,
    ],
    [
      'an insert-compatible activity event shape',
      `DROP TABLE task_activity_events;
       CREATE TABLE task_activity_events (
         motrix_id TEXT NOT NULL,
         kind TEXT NOT NULL
           CHECK (kind IN ('submitted', 'download_completed')),
         occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
         accuracy TEXT NOT NULL DEFAULT 'exact'
           CHECK (accuracy IN ('exact', 'recovered')),
         required_extra TEXT NOT NULL,
         PRIMARY KEY (motrix_id, kind)
       ) WITHOUT ROWID;
       CREATE INDEX idx_task_activity_time
         ON task_activity_events(occurred_at, kind, accuracy)`,
    ],
    [
      'canonical activity kind constraints',
      `DROP TABLE task_activity_events;
       CREATE TABLE task_activity_events (
         motrix_id TEXT NOT NULL,
         kind TEXT NOT NULL CHECK (kind = 'submitted'),
         occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
         accuracy TEXT NOT NULL DEFAULT 'exact'
           CHECK (accuracy IN ('exact', 'recovered')),
         PRIMARY KEY (motrix_id, kind)
       ) WITHOUT ROWID;
       CREATE INDEX idx_task_activity_time
         ON task_activity_events(occurred_at, kind, accuracy)`,
    ],
    [
      'writable activity metadata',
      `DROP TABLE task_activity_meta;
       CREATE TABLE task_activity_meta (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         generation TEXT NOT NULL CHECK (length(generation) > 0),
         tracking_started_at INTEGER NOT NULL,
         revision INTEGER NOT NULL DEFAULT 0 CHECK (revision = 0),
         coverage_gap_at INTEGER
       );
       INSERT INTO task_activity_meta (
         id,
         generation,
         tracking_started_at,
         revision,
         coverage_gap_at
       ) VALUES (1, 'stale-generation', 1, 0, NULL)`,
    ],
    [
      'integer activity coverage metadata',
      `DROP TABLE task_activity_meta;
       CREATE TABLE task_activity_meta (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         generation TEXT NOT NULL CHECK (length(generation) > 0),
         tracking_started_at INTEGER NOT NULL,
         revision INTEGER NOT NULL DEFAULT 0,
         coverage_gap_at TEXT
       );
       INSERT INTO task_activity_meta (
         id,
         generation,
         tracking_started_at,
         revision,
         coverage_gap_at
       ) VALUES (1, 'stale-generation', 1, 0, NULL)`,
    ],
    [
      'a trigger-free activity ledger',
      `CREATE TRIGGER ignore_completed_activity
       BEFORE INSERT ON task_activity_events
       WHEN NEW.kind = 'download_completed'
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    ],
  ])(
    'fails fast when a versioned database has incompatible %s',
    async (_label, sql) => {
      const { migrate, StaleSchemaError } = await import('.')
      const db = new Database(':memory:')
      db.pragma('foreign_keys = ON')
      migrate(db)
      db.exec(sql)

      let thrown: unknown
      try {
        migrate(db)
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(StaleSchemaError)
      expect((thrown as InstanceType<typeof StaleSchemaError>).reason).toBe(
        'activity_schema_missing'
      )

      db.close()
    }
  )
})
