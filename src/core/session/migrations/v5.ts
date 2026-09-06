import type Database from 'better-sqlite3'
import { V2_TASK_SCHEMA_OBJECTS } from './v2'

// ALTER TABLE preserves the existing DDL and inserts the new column before
// its closing parenthesis. Keep validation compatible with upgraded databases.
export const V5_TASK_SCHEMA_OBJECTS = V2_TASK_SCHEMA_OBJECTS.map((object) =>
  object.name === 'tasks'
    ? { ...object, sql: object.sql.replace(/\)\s*$/, ', save_dir TEXT)') }
    : object
)

export const v5 = {
  version: 5,
  up(db: Database.Database): void {
    db.exec('ALTER TABLE tasks ADD COLUMN save_dir TEXT')
    // Existing finalize journals retain the original root even when a plugin
    // chose a nested target. Other legacy rows are reconstructed on restore.
    db.exec(`UPDATE tasks SET save_dir = (
      SELECT json_extract(plan_json, '$.saveDir')
      FROM plugin_finalize_journals WHERE task_id = tasks.motrix_id
        AND json_type(plan_json, '$.saveDir') = 'text'
    )`)
  },
}
