import {
  type TaskTrackerState,
  taskTrackerStateSchema,
} from '@shared/schemas/task-tracker'
import type Database from 'better-sqlite3'

/** Task-owned journal; task deletion cascades in the same SQLite transaction. */
export class TaskTrackerRepository {
  constructor(private readonly db: Database.Database) {}
  get(taskId: string): TaskTrackerState | null {
    const row = this.db
      .prepare('SELECT state FROM task_tracker_state WHERE motrix_id = ?')
      .get(taskId) as { state: string } | undefined
    return row ? taskTrackerStateSchema.parse(JSON.parse(row.state)) : null
  }
  save(taskId: string, state: TaskTrackerState): void {
    const value = JSON.stringify(taskTrackerStateSchema.parse(state))
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO task_tracker_state (motrix_id, state) VALUES (?, ?)
        ON CONFLICT(motrix_id) DO UPDATE SET state = excluded.state`)
        .run(taskId, value)
    })()
  }
  pendingTaskIds(): string[] {
    return (
      this.db
        .prepare(
          "SELECT motrix_id FROM task_tracker_state WHERE json_type(state, '$.pending') = 'object'"
        )
        .all() as { motrix_id: string }[]
    ).map((row) => row.motrix_id)
  }
}
