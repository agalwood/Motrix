import type Database from 'better-sqlite3'
import { CANONICAL_TASK_INDEX_OBJECTS, type SchemaObjectDefinition } from './v1'

/**
 * Exact task-owned objects produced by the v2 rebuild. SQLite quotes renamed
 * table names and rewritten foreign-key targets in sqlite_master; those
 * quotes are intentionally part of the persisted canonical representation.
 */
export const V2_TASK_SCHEMA_OBJECTS: readonly SchemaObjectDefinition[] = [
  {
    name: 'tasks',
    sql: `CREATE TABLE "tasks" (
        motrix_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'direct'
          CHECK (kind IN ('direct','bt','hls','mux')),
        task_type TEXT NOT NULL
          CHECK (task_type IN ('http','ftp','bt','magnet','metalink')),
        category TEXT,
        priority INTEGER NOT NULL DEFAULT 0
          CHECK (priority BETWEEN -100 AND 100),
        tags TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        final_path TEXT NOT NULL DEFAULT '',
        final_name TEXT NOT NULL DEFAULT '',
        torrent_meta_path TEXT,
        info_hash TEXT,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        downloaded_bytes INTEGER NOT NULL DEFAULT 0,
        size_when_done INTEGER NOT NULL DEFAULT 0,
        file_count INTEGER NOT NULL DEFAULT 0,
        is_private INTEGER NOT NULL DEFAULT 0
          CHECK (is_private IN (0, 1)),
        trackers TEXT NOT NULL DEFAULT '[]',
        piece_length INTEGER NOT NULL DEFAULT 0,
        agg_status TEXT NOT NULL DEFAULT 'queued'
          CHECK (agg_status IN (
            'queued','fetching_metadata','metadata_ready',
            'downloading','finalizing',
            'seeding','paused','completed','error','removed'
          )),
        finished_at INTEGER,
        error_message TEXT,
        error_code TEXT,
        error_detail_key TEXT,
        error_detail_params TEXT,
        diagnosis_revision INTEGER NOT NULL DEFAULT 0,
        uploaded_bytes_baseline INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'user',
        source_meta TEXT
      )`,
  },
  {
    name: 'task_instances',
    sql: `CREATE TABLE "task_instances" (
        instance_id TEXT PRIMARY KEY,
        motrix_id TEXT NOT NULL,
        gid TEXT UNIQUE,
        phase TEXT NOT NULL
          CHECK (phase IN (
            'http_download',
            'bt_download',
            'magnet_metadata_resolution',
            'hls_segment',
            'hls_subtitle',
            'hls_audio',
            'ffmpeg_mux'
          )),
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN (
            'queued','fetching_metadata','metadata_ready',
            'downloading','finalizing',
            'seeding','paused','completed','error','removed'
          )),
        progress INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        downloaded_bytes INTEGER NOT NULL DEFAULT 0,
        uploaded_bytes INTEGER NOT NULL DEFAULT 0,
        disk_path TEXT NOT NULL DEFAULT '',
        transition_phase TEXT NOT NULL DEFAULT 'idle'
          CHECK (transition_phase IN ('idle','renaming','reseeding')),
        uris TEXT NOT NULL DEFAULT '[]',
        uri_hash TEXT,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (motrix_id)
          REFERENCES "tasks"(motrix_id) ON DELETE CASCADE
      )`,
  },
  {
    name: 'task_files',
    sql: `CREATE TABLE "task_files" (
        motrix_id TEXT NOT NULL,
        file_index INTEGER NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        selected INTEGER NOT NULL DEFAULT 1 CHECK (selected IN (0, 1)),
        PRIMARY KEY (motrix_id, file_index),
        FOREIGN KEY (motrix_id)
          REFERENCES "tasks"(motrix_id) ON DELETE CASCADE
      ) WITHOUT ROWID`,
  },
  ...CANONICAL_TASK_INDEX_OBJECTS,
]

/**
 * Plan B follow-up: widen `tasks.agg_status` and `task_instances.status`
 * CHECK constraints to allow `metadata_ready`. The new value
 * represents "aria2 has resolved the .torrent metadata and parsed the
 * file list, but the user has not yet confirmed file selection" — an
 * intermediate state between FetchingMetadata and the bt_download
 * swap. Without it the Downloads pill stays on "Fetching" forever
 * after metadata arrives, which is misleading.
 *
 * SQLite cannot ALTER an existing CHECK constraint, so we rebuild
 * both tables. The rebuild uses the CREATE-temp-INSERT-DROP-RENAME
 * dance:
 *
 *   1. Create a replacement parent and replacement copies of both child
 *      tables. The replacement children reference `tasks_v2new`, never the
 *      parent that is about to be dropped.
 *   2. Copy parent and child rows.
 *   3. Drop the old children before the old parent, preventing ON DELETE
 *      CASCADE from deleting the copied rows.
 *   4. Rename the replacement parent, then both replacement children.
 *      SQLite rewrites their FK target to the canonical `tasks` name.
 *   5. Recreate the indexes and verify the resulting FK graph.
 *
 * We deliberately avoid ALTER TABLE RENAME on the original tables:
 * SQLite (since 3.26) auto-rewrites FK target strings in referrers,
 * which would point `task_files` at a transient name we'd then drop
 * — leaving its FK forever dangling and causing "no such table"
 * errors on subsequent prepare() calls.
 *
 * The migration runs inside the runner's transaction. PRAGMA
 * foreign_keys cannot be toggled mid-transaction (SQLite no-ops it),
 * but since none of the rebuild steps insert/delete rows in a way
 * that would trigger FK violations, this is fine.
 */
export const v2 = {
  version: 2,
  up(db: Database.Database): void {
    const sql = `
      CREATE TABLE tasks_v2new (
        motrix_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'direct'
          CHECK (kind IN ('direct','bt','hls','mux')),
        task_type TEXT NOT NULL
          CHECK (task_type IN ('http','ftp','bt','magnet','metalink')),
        category TEXT,
        priority INTEGER NOT NULL DEFAULT 0
          CHECK (priority BETWEEN -100 AND 100),
        tags TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        final_path TEXT NOT NULL DEFAULT '',
        final_name TEXT NOT NULL DEFAULT '',
        torrent_meta_path TEXT,
        info_hash TEXT,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        downloaded_bytes INTEGER NOT NULL DEFAULT 0,
        size_when_done INTEGER NOT NULL DEFAULT 0,
        file_count INTEGER NOT NULL DEFAULT 0,
        is_private INTEGER NOT NULL DEFAULT 0
          CHECK (is_private IN (0, 1)),
        trackers TEXT NOT NULL DEFAULT '[]',
        piece_length INTEGER NOT NULL DEFAULT 0,
        agg_status TEXT NOT NULL DEFAULT 'queued'
          CHECK (agg_status IN (
            'queued','fetching_metadata','metadata_ready',
            'downloading','finalizing',
            'seeding','paused','completed','error','removed'
          )),
        finished_at INTEGER,
        error_message TEXT,
        error_code TEXT,
        error_detail_key TEXT,
        error_detail_params TEXT,
        diagnosis_revision INTEGER NOT NULL DEFAULT 0,
        uploaded_bytes_baseline INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'user',
        source_meta TEXT
      );

      INSERT INTO tasks_v2new (
        motrix_id,
        name,
        kind,
        task_type,
        category,
        priority,
        tags,
        created_at,
        updated_at,
        final_path,
        final_name,
        torrent_meta_path,
        info_hash,
        total_bytes,
        downloaded_bytes,
        size_when_done,
        file_count,
        is_private,
        trackers,
        piece_length,
        agg_status,
        finished_at,
        error_message,
        error_code,
        error_detail_key,
        error_detail_params,
        diagnosis_revision,
        uploaded_bytes_baseline,
        source,
        source_meta
      )
      SELECT
        motrix_id,
        name,
        kind,
        task_type,
        category,
        priority,
        tags,
        created_at,
        updated_at,
        final_path,
        final_name,
        torrent_meta_path,
        info_hash,
        total_bytes,
        downloaded_bytes,
        size_when_done,
        file_count,
        is_private,
        trackers,
        piece_length,
        agg_status,
        finished_at,
        error_message,
        error_code,
        error_detail_key,
        error_detail_params,
        diagnosis_revision,
        uploaded_bytes_baseline,
        source,
        source_meta
      FROM tasks;

      CREATE TABLE task_instances_v2new (
        instance_id TEXT PRIMARY KEY,
        motrix_id TEXT NOT NULL,
        gid TEXT UNIQUE,
        phase TEXT NOT NULL
          CHECK (phase IN (
            'http_download',
            'bt_download',
            'magnet_metadata_resolution',
            'hls_segment',
            'hls_subtitle',
            'hls_audio',
            'ffmpeg_mux'
          )),
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN (
            'queued','fetching_metadata','metadata_ready',
            'downloading','finalizing',
            'seeding','paused','completed','error','removed'
          )),
        progress INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        downloaded_bytes INTEGER NOT NULL DEFAULT 0,
        uploaded_bytes INTEGER NOT NULL DEFAULT 0,
        disk_path TEXT NOT NULL DEFAULT '',
        transition_phase TEXT NOT NULL DEFAULT 'idle'
          CHECK (transition_phase IN ('idle','renaming','reseeding')),
        uris TEXT NOT NULL DEFAULT '[]',
        uri_hash TEXT,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (motrix_id)
          REFERENCES tasks_v2new(motrix_id) ON DELETE CASCADE
      );

      INSERT INTO task_instances_v2new (
        instance_id,
        motrix_id,
        gid,
        phase,
        status,
        progress,
        total_bytes,
        downloaded_bytes,
        uploaded_bytes,
        disk_path,
        transition_phase,
        uris,
        uri_hash,
        payload,
        created_at,
        updated_at
      )
      SELECT
        instance_id,
        motrix_id,
        gid,
        phase,
        status,
        progress,
        total_bytes,
        downloaded_bytes,
        uploaded_bytes,
        disk_path,
        transition_phase,
        uris,
        uri_hash,
        payload,
        created_at,
        updated_at
      FROM task_instances;

      CREATE TABLE task_files_v2new (
        motrix_id TEXT NOT NULL,
        file_index INTEGER NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        selected INTEGER NOT NULL DEFAULT 1 CHECK (selected IN (0, 1)),
        PRIMARY KEY (motrix_id, file_index),
        FOREIGN KEY (motrix_id)
          REFERENCES tasks_v2new(motrix_id) ON DELETE CASCADE
      ) WITHOUT ROWID;

      INSERT INTO task_files_v2new (
        motrix_id,
        file_index,
        path,
        size,
        selected
      )
      SELECT
        motrix_id,
        file_index,
        path,
        size,
        selected
      FROM task_files;

      DROP TABLE task_instances;
      DROP TABLE task_files;
      DROP TABLE tasks;

      ALTER TABLE tasks_v2new RENAME TO tasks;
      ALTER TABLE task_instances_v2new RENAME TO task_instances;
      ALTER TABLE task_files_v2new RENAME TO task_files;

      CREATE INDEX idx_tasks_info_hash
        ON tasks(info_hash) WHERE info_hash IS NOT NULL;
      CREATE INDEX idx_tasks_status_created
        ON tasks(agg_status, created_at DESC);
      CREATE INDEX idx_task_instances_motrix_id
        ON task_instances(motrix_id);
      CREATE INDEX idx_task_instances_gid
        ON task_instances(gid) WHERE gid IS NOT NULL;
      CREATE INDEX idx_task_instances_uri_hash
        ON task_instances(uri_hash) WHERE uri_hash IS NOT NULL;
      CREATE INDEX idx_task_instances_phase_status
        ON task_instances(phase, status);
    `
    db.exec(sql)
    const foreignKeyViolations = db.pragma('foreign_key_check') as unknown[]
    if (foreignKeyViolations.length > 0) {
      throw new Error('v2 migration produced foreign-key violations')
    }
  },
}
