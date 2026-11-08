import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate } from '.'
import { v1 } from './v1'
import { v2 } from './v2'
import { v3 } from './v3'
import { v4 } from './v4'
import { v5 } from './v5'
import { v6 } from './v6'
import { v7 } from './v7'
import { v8 } from './v8'
import { v9 } from './v9'

describe('empty-gid repair migration v9', () => {
  it('clears legacy empty-string task_instances.gid rows to NULL', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(`CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`)
    for (const migration of [v1, v2, v3, v4, v5, v6, v7, v8]) {
      migration.up(db)
      db.prepare('INSERT INTO schema_version VALUES (?, 1)').run(
        migration.version
      )
    }
    db.exec(
      "INSERT INTO tasks (motrix_id,name,task_type,created_at,updated_at) VALUES ('t1','one','http',1,1)"
    )
    // The poisoned row: an empty string occupies the global UNIQUE(gid) slot.
    db.exec(
      `INSERT INTO task_instances (
        instance_id,motrix_id,gid,phase,status,progress,total_bytes,
        downloaded_bytes,uploaded_bytes,disk_path,transition_phase,uris,
        uri_hash,payload,created_at,updated_at
      ) VALUES ('seg:t1','t1','','hls_segment','completed',0,0,0,0,'','idle','[]',null,'{}',1,1)`
    )

    migrate(db)

    const row = db
      .prepare("SELECT gid FROM task_instances WHERE instance_id='seg:t1'")
      .get() as { gid: string | null }
    expect(row.gid).toBeNull()
    // The freed slot means other empty-gid rows can now be inserted.
    expect(() =>
      db
        .prepare(
          `INSERT INTO task_instances (
            instance_id,motrix_id,gid,phase,status,progress,total_bytes,
            downloaded_bytes,uploaded_bytes,disk_path,transition_phase,uris,
            uri_hash,payload,created_at,updated_at
          ) VALUES ('seg:t1b','t1','','ffmpeg_mux','completed',0,0,0,0,'','idle','[]',null,'{}',1,1)`
        )
        .run()
    ).not.toThrow()
    // v9 is data-only: the chain records it, so a second migrate() is a noop.
    expect(
      db.prepare('SELECT MAX(version) AS v FROM schema_version').get()
    ).toEqual({ v: 9 })
    expect(() => migrate(db)).not.toThrow()
    expect(() => v9.up(db)).not.toThrow()
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    db.close()
  })
})
