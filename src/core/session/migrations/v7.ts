import type Database from 'better-sqlite3'
import type { SchemaObjectDefinition } from './v1'

export const V7_SCHEMA_OBJECTS: readonly SchemaObjectDefinition[] = [
  {
    name: 'task_tracker_state',
    sql: `CREATE TABLE task_tracker_state (
    motrix_id TEXT NOT NULL PRIMARY KEY
      CHECK (typeof(motrix_id) = 'text' AND length(motrix_id) > 0),
    state TEXT NOT NULL CHECK (typeof(state) = 'text' AND json_valid(state)),
    FOREIGN KEY (motrix_id) REFERENCES tasks(motrix_id) ON DELETE CASCADE
  ) WITHOUT ROWID`,
  },
]
export const v7 = {
  version: 7,
  up(db: Database.Database): void {
    for (const object of V7_SCHEMA_OBJECTS) db.exec(object.sql)
  },
}
