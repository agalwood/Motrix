import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface SchemaObjectDefinition {
  name: string
  sql: string
}

export const CANONICAL_TASK_INDEX_OBJECTS: readonly SchemaObjectDefinition[] = [
  {
    name: 'idx_tasks_info_hash',
    sql: `CREATE INDEX idx_tasks_info_hash
        ON tasks(info_hash) WHERE info_hash IS NOT NULL`,
  },
  {
    name: 'idx_tasks_status_created',
    sql: `CREATE INDEX idx_tasks_status_created
        ON tasks(agg_status, created_at DESC)`,
  },
  {
    name: 'idx_task_instances_motrix_id',
    sql: `CREATE INDEX idx_task_instances_motrix_id
        ON task_instances(motrix_id)`,
  },
  {
    name: 'idx_task_instances_gid',
    sql: `CREATE INDEX idx_task_instances_gid
        ON task_instances(gid) WHERE gid IS NOT NULL`,
  },
  {
    name: 'idx_task_instances_uri_hash',
    sql: `CREATE INDEX idx_task_instances_uri_hash
        ON task_instances(uri_hash) WHERE uri_hash IS NOT NULL`,
  },
  {
    name: 'idx_task_instances_phase_status',
    sql: `CREATE INDEX idx_task_instances_phase_status
        ON task_instances(phase, status)`,
  },
]

/**
 * Exact task-owned v1 objects used to preflight a database that declares v1.
 * Keep these definitions in lockstep with the DDL in v1.up: migration safety
 * depends on rejecting reordered columns and weakened constraints before v2
 * copies any rows.
 */
export const V1_TASK_SCHEMA_OBJECTS: readonly SchemaObjectDefinition[] = [
  {
    name: 'tasks',
    sql: `CREATE TABLE tasks (
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
            'queued','fetching_metadata','downloading','finalizing',
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
    sql: `CREATE TABLE task_instances (
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
            'queued','fetching_metadata','downloading','finalizing',
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
        FOREIGN KEY (motrix_id) REFERENCES tasks(motrix_id) ON DELETE CASCADE
      )`,
  },
  {
    name: 'task_files',
    sql: `CREATE TABLE task_files (
        motrix_id TEXT NOT NULL,
        file_index INTEGER NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        selected INTEGER NOT NULL DEFAULT 1 CHECK (selected IN (0, 1)),
        PRIMARY KEY (motrix_id, file_index),
        FOREIGN KEY (motrix_id) REFERENCES tasks(motrix_id) ON DELETE CASCADE
      ) WITHOUT ROWID`,
  },
  ...CANONICAL_TASK_INDEX_OBJECTS,
]

/**
 * Canonical non-task objects inherited unchanged by every later migration.
 * These definitions are also the DDL source used by v1.up so declared-version
 * preflight and final-schema validation cannot drift from creation.
 */
export const V1_INHERITED_SCHEMA_OBJECTS: readonly SchemaObjectDefinition[] = [
  {
    name: 'plugin_state',
    sql: `CREATE TABLE plugin_state (
        plugin_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'inactive',
        last_error TEXT,
        error_count INTEGER NOT NULL DEFAULT 0,
        installed_at INTEGER NOT NULL,
        last_activated_at INTEGER
      )`,
  },
  {
    name: 'transfer_totals',
    sql: `CREATE TABLE transfer_totals (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        download_bytes INTEGER NOT NULL DEFAULT 0
          CHECK (
            typeof(download_bytes) = 'integer' AND download_bytes >= 0
          ),
        upload_bytes INTEGER NOT NULL DEFAULT 0
          CHECK (
            typeof(upload_bytes) = 'integer' AND upload_bytes >= 0
          ),
        tracking_started_at INTEGER NOT NULL,
        updated_at INTEGER
      )`,
  },
  {
    name: 'transfer_buckets',
    sql: `CREATE TABLE transfer_buckets (
        bucket_start_ms INTEGER PRIMARY KEY,
        download_bytes INTEGER NOT NULL DEFAULT 0
          CHECK (
            typeof(download_bytes) = 'integer' AND download_bytes >= 0
          ),
        upload_bytes INTEGER NOT NULL DEFAULT 0
          CHECK (
            typeof(upload_bytes) = 'integer' AND upload_bytes >= 0
          ),
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID`,
  },
]

/**
 * Canonical activity DDL, exported so migrate() can verify an existing
 * database against the exact objects this migration creates. The token
 * stream must stay byte-compatible (after whitespace normalization) with
 * what earlier builds wrote into sqlite_master.
 */
export const ACTIVITY_SCHEMA_OBJECTS: readonly SchemaObjectDefinition[] = [
  {
    name: 'task_activity_meta',
    sql: `CREATE TABLE task_activity_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        generation TEXT NOT NULL CHECK (length(generation) > 0),
        tracking_started_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        coverage_gap_at INTEGER
      )`,
  },
  {
    name: 'task_activity_events',
    sql: `CREATE TABLE task_activity_events (
        motrix_id TEXT NOT NULL,
        kind TEXT NOT NULL
          CHECK (kind IN ('submitted', 'download_completed')),
        occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
        accuracy TEXT NOT NULL DEFAULT 'exact'
          CHECK (accuracy IN ('exact', 'recovered')),
        PRIMARY KEY (motrix_id, kind)
      ) WITHOUT ROWID`,
  },
  {
    name: 'idx_task_activity_time',
    sql: `CREATE INDEX idx_task_activity_time
        ON task_activity_events(occurred_at, kind, accuracy)`,
  },
]

export const v1 = {
  version: 1,
  up(db: Database.Database): void {
    db.exec(`
      CREATE TABLE tasks (
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
            'queued','fetching_metadata','downloading','finalizing',
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

      CREATE INDEX idx_tasks_info_hash
        ON tasks(info_hash) WHERE info_hash IS NOT NULL;
      CREATE INDEX idx_tasks_status_created
        ON tasks(agg_status, created_at DESC);

      CREATE TABLE task_instances (
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
            'queued','fetching_metadata','downloading','finalizing',
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
        FOREIGN KEY (motrix_id) REFERENCES tasks(motrix_id) ON DELETE CASCADE
      );

      CREATE INDEX idx_task_instances_motrix_id
        ON task_instances(motrix_id);
      CREATE INDEX idx_task_instances_gid
        ON task_instances(gid) WHERE gid IS NOT NULL;
      CREATE INDEX idx_task_instances_uri_hash
        ON task_instances(uri_hash) WHERE uri_hash IS NOT NULL;
      CREATE INDEX idx_task_instances_phase_status
        ON task_instances(phase, status);

      CREATE TABLE task_files (
        motrix_id TEXT NOT NULL,
        file_index INTEGER NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        selected INTEGER NOT NULL DEFAULT 1 CHECK (selected IN (0, 1)),
        PRIMARY KEY (motrix_id, file_index),
        FOREIGN KEY (motrix_id) REFERENCES tasks(motrix_id) ON DELETE CASCADE
      ) WITHOUT ROWID;

    `)

    for (const object of V1_INHERITED_SCHEMA_OBJECTS) {
      db.exec(object.sql)
    }

    for (const object of ACTIVITY_SCHEMA_OBJECTS) {
      db.exec(object.sql)
    }

    db.prepare(
      `INSERT INTO task_activity_meta (
        id,
        generation,
        tracking_started_at
      ) VALUES (1, ?, ?)`
    ).run(randomUUID(), Date.now())
  },
}
