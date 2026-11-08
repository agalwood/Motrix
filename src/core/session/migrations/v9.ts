import type Database from 'better-sqlite3'

/**
 * v9 repairs the `task_instances.gid` "empty string" defect.
 *
 * `gid` is a globally UNIQUE, nullable column: the absence of an engine gid is
 * represented by NULL. Older writers (a synthesized primary instance copying
 * an empty `task.engineTaskId`, and any in-memory instance carrying `''`)
 * stored the empty string instead. Because SQLite treats `''` as an ordinary
 * value, the first such row permanently occupied the single `''` slot in the
 * UNIQUE index, so every later task with an empty-gid instance (HLS segment,
 * mux, subtitle, …) failed to persist with
 * `SQLITE_CONSTRAINT_UNIQUE: task_instances.gid`, taking the whole
 * `saveTasksBatch` transaction — and thus the task's durability — down with it.
 *
 * The forward fix normalizes `'' -> NULL` at the persistence boundary
 * (`MotrixDatabase.serializeInstance`) and on read (`mapInstanceRow`). This
 * migration clears the rows already on disk so the poisoned slot is freed
 * immediately rather than only once the owning task is next written.
 */
export const v9 = {
  version: 9,
  up(db: Database.Database): void {
    db.prepare("UPDATE task_instances SET gid = NULL WHERE gid = ''").run()
  },
}
