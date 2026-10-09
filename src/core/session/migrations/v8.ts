import type Database from 'better-sqlite3'
import type { SchemaObjectDefinition } from './v1'

export const V8_SCHEMA_OBJECTS: readonly SchemaObjectDefinition[] = [
  {
    name: 'legacy_import_runs',
    sql: `CREATE TABLE legacy_import_runs (
    run_id TEXT PRIMARY KEY NOT NULL,
    source_id TEXT NOT NULL,
    snapshot_digest TEXT NOT NULL,
    backup_path TEXT,
    report TEXT NOT NULL CHECK (json_valid(report)),
    created_at INTEGER NOT NULL
  )`,
  },
  {
    name: 'legacy_import_items',
    sql: `CREATE TABLE legacy_import_items (
    run_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('imported', 'skipped', 'failed', 'unprocessed')),
    task_id TEXT,
    PRIMARY KEY (run_id, item_key),
    FOREIGN KEY (run_id) REFERENCES legacy_import_runs(run_id) ON DELETE CASCADE
  ) WITHOUT ROWID`,
  },
  {
    name: 'legacy_import_ledger',
    sql: `CREATE TABLE legacy_import_ledger (
    source_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    entry_digest TEXT NOT NULL,
    task_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('imported', 'user-deleted')),
    PRIMARY KEY (source_id, item_key)
  ) WITHOUT ROWID`,
  },
  {
    name: 'legacy_import_invitation',
    sql: `CREATE TABLE legacy_import_invitation (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    dismissed INTEGER NOT NULL CHECK (dismissed IN (0, 1))
  )`,
  },
  {
    name: 'legacy_import_delete_tombstone',
    sql: `CREATE TRIGGER legacy_import_delete_tombstone BEFORE DELETE ON tasks BEGIN
    UPDATE legacy_import_ledger SET state = 'user-deleted' WHERE task_id = OLD.motrix_id;
  END`,
  },
]

export const v8 = {
  version: 8,
  up(db: Database.Database): void {
    for (const object of V8_SCHEMA_OBJECTS) db.exec(object.sql)
    db.prepare('INSERT INTO legacy_import_invitation VALUES (1, 0)').run()
  },
}
