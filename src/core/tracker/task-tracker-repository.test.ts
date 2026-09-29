import { migrate } from '@core/session/migrations'
import { v1 } from '@core/session/migrations/v1'
import { v2 } from '@core/session/migrations/v2'
import { v3 } from '@core/session/migrations/v3'
import { v4 } from '@core/session/migrations/v4'
import { v5 } from '@core/session/migrations/v5'
import { v6 } from '@core/session/migrations/v6'
import {
  type TaskTrackerState,
  taskTrackerStateSchema,
} from '@shared/schemas/task-tracker'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { TaskTrackerRepository } from './task-tracker-repository'

const state: TaskTrackerState = {
  engineGid: 'gid',
  revision: 1,
  original: ['https://native/announce'],
  manual: [],
  managed: ['udp://public:80'],
  excluded: [],
  isPrivate: false,
  pending: null,
}

describe('task Tracker persistence', () => {
  it('migrates v6 without inventing ownership; roundtrips pending state and cascades deletion', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(`CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`)
    for (const migration of [v1, v2, v3, v4, v5, v6]) {
      migration.up(db)
      db.prepare('INSERT INTO schema_version VALUES (?, 1)').run(
        migration.version
      )
    }
    db.exec(
      "INSERT INTO tasks (motrix_id,name,task_type,created_at,updated_at) VALUES ('task','file','bt',1,1)"
    )
    migrate(db)
    const store = new TaskTrackerRepository(db)
    expect(store.get('task')).toBeNull()
    const pending = {
      ...state,
      pending: {
        before: [],
        after: state.managed,
        next: state,
        resumeRequired: true,
      },
    }
    store.save('task', pending)
    expect(new TaskTrackerRepository(db).get('task')).toEqual(
      taskTrackerStateSchema.parse(pending)
    )
    expect(store.pendingTaskIds()).toEqual(['task'])
    store.save('task', state)
    expect(store.pendingTaskIds()).toEqual([])
    expect(() => store.save('missing', state)).toThrow()
    db.exec("DELETE FROM tasks WHERE motrix_id = 'task'")
    expect(store.get('task')).toBeNull()
    expect(() => migrate(db)).not.toThrow()
    db.close()
  })
  it('rejects a damaged journal schema instead of silently losing ownership', () => {
    const db = new Database(':memory:')
    migrate(db)
    db.exec('DROP TABLE task_tracker_state')
    expect(() => migrate(db)).toThrow('Tracker ownership journal')
    db.close()
  })
})
