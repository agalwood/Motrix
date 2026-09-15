import type Database from 'better-sqlite3'
import type { SchemaObjectDefinition } from './v1'

export const V6_SCHEMA_OBJECTS: readonly SchemaObjectDefinition[] = [
  {
    name: 'task_seeding_activity',
    sql: `CREATE TABLE task_seeding_activity (
    motrix_id TEXT NOT NULL PRIMARY KEY
      CHECK (typeof(motrix_id) = 'text' AND length(motrix_id) > 0),
    tracking_started_at INTEGER NOT NULL
      CHECK (typeof(tracking_started_at) = 'integer' AND tracking_started_at BETWEEN 1 AND 9007199254740991),
    seeding_ms INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(seeding_ms) = 'integer' AND seeding_ms BETWEEN 0 AND 9007199254740991),
    FOREIGN KEY (motrix_id) REFERENCES tasks(motrix_id) ON DELETE CASCADE
  ) WITHOUT ROWID`,
  },
]

export const v6 = {
  version: 6,
  up(db: Database.Database): void {
    // No historical backfill: activity before this counter existed is unknown.
    for (const object of V6_SCHEMA_OBJECTS) db.exec(object.sql)
  },
}
