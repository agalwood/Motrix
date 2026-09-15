import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { TaskInspectorActivityStore } from '../../inspector-activity/task-inspector-activity-store'
import { migrate } from '.'
import { v1 } from './v1'
import { v2 } from './v2'
import { v3 } from './v3'
import { v4 } from './v4'
import { v5 } from './v5'

describe('seeding activity migration v6', () => {
  it('preserves old activity without inventing historical seeding time', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(`CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`)
    for (const migration of [v1, v2, v3, v4, v5]) {
      migration.up(db)
      db.prepare('INSERT INTO schema_version VALUES (?, 1)').run(
        migration.version
      )
    }
    db.exec(
      "INSERT INTO tasks (motrix_id,name,task_type,created_at,updated_at) VALUES ('old','file','bt',1,1)"
    )
    db.exec(
      "INSERT INTO task_inspector_activity (motrix_id,tracking_started_at,updated_at,active_ms) VALUES ('old',1,1000,999)"
    )
    migrate(db)
    const store = new TaskInspectorActivityStore(db)
    expect(store.snapshot('old')?.summary).toMatchObject({
      activeMs: 999,
      seeding: null,
    })
    store.ensureTask('old', 2000)
    expect(store.snapshot('old')?.summary.seeding).toEqual({
      activeMs: 0,
      trackingStartedAt: 2000,
    })
    expect(() => migrate(db)).not.toThrow()
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    db.close()
  })
})
