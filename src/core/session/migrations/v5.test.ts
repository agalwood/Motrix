import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate } from '.'
import { v1 } from './v1'
import { v2 } from './v2'
import { v3 } from './v3'
import { v4 } from './v4'

describe('save directory migration', () => {
  it('upgrades existing tasks and recovers the original root from their journal', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`)
    for (const migration of [v1, v2, v3, v4]) {
      migration.up(db)
      db.prepare('INSERT INTO schema_version VALUES (?, 1)').run(
        migration.version
      )
    }
    db.exec(`INSERT INTO tasks (motrix_id, name, task_type, created_at, updated_at, final_path)
      VALUES ('interrupted', 'movie', 'bt', 1, 1, '/downloads/Movies/movie'),
        ('legacy', 'file', 'http', 1, 1, '/downloads/file')`)
    db.prepare(`INSERT INTO plugin_finalize_journals
      (plan_id, task_id, phase, plan_json, source_identity_json, created_at, updated_at)
      VALUES ('plan', 'interrupted', 'prepared', ?, '{}', 1, 1)`).run(
      JSON.stringify({
        saveDir: '/downloads',
        targetPath: '/downloads/Movies/movie',
      })
    )
    migrate(db)
    expect(
      db
        .prepare('SELECT save_dir FROM tasks WHERE motrix_id = ?')
        .get('interrupted')
    ).toEqual({ save_dir: '/downloads' })
    expect(
      db.prepare('SELECT save_dir FROM tasks WHERE motrix_id = ?').get('legacy')
    ).toEqual({ save_dir: null })
    expect(() => migrate(db)).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({
      n: 2,
    })
    db.close()
  })
})
