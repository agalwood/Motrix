import type Database from 'better-sqlite3'
import type { SchemaObjectDefinition } from './v1'

export const V3_SCHEMA_OBJECTS: readonly SchemaObjectDefinition[] = [
  {
    name: 'task_inspector_activity',
    sql: `CREATE TABLE task_inspector_activity (
      motrix_id TEXT NOT NULL PRIMARY KEY
        CHECK (typeof(motrix_id) = 'text' AND length(motrix_id) > 0),
      tracking_started_at INTEGER NOT NULL
        CHECK (
          typeof(tracking_started_at) = 'integer'
          AND tracking_started_at BETWEEN 1 AND 9007199254740991
        ),
      coverage_gap_at INTEGER
        CHECK (
          coverage_gap_at IS NULL
          OR (
            typeof(coverage_gap_at) = 'integer'
            AND coverage_gap_at BETWEEN 1 AND 9007199254740991
          )
        ),
      revision INTEGER NOT NULL DEFAULT 0
        CHECK (
          typeof(revision) = 'integer'
          AND revision BETWEEN 0 AND 9007199254740991
        ),
      last_event_ordinal INTEGER NOT NULL DEFAULT 0
        CHECK (
          typeof(last_event_ordinal) = 'integer'
          AND last_event_ordinal BETWEEN 0 AND 9007199254740991
        ),
      active_ms INTEGER NOT NULL DEFAULT 0
        CHECK (
          typeof(active_ms) = 'integer'
          AND active_ms BETWEEN 0 AND 9007199254740991
        ),
      download_active_ms INTEGER NOT NULL DEFAULT 0
        CHECK (
          typeof(download_active_ms) = 'integer'
          AND download_active_ms BETWEEN 0 AND 9007199254740991
        ),
      estimated_download_bytes INTEGER NOT NULL DEFAULT 0
        CHECK (
          typeof(estimated_download_bytes) = 'integer'
          AND estimated_download_bytes BETWEEN 0 AND 9223372036854775807
        ),
      estimated_upload_bytes INTEGER NOT NULL DEFAULT 0
        CHECK (
          typeof(estimated_upload_bytes) = 'integer'
          AND estimated_upload_bytes BETWEEN 0 AND 9223372036854775807
        ),
      peak_download_bps INTEGER NOT NULL DEFAULT 0
        CHECK (
          typeof(peak_download_bps) = 'integer'
          AND peak_download_bps BETWEEN 0 AND 9007199254740991
        ),
      peak_upload_bps INTEGER NOT NULL DEFAULT 0
        CHECK (
          typeof(peak_upload_bps) = 'integer'
          AND peak_upload_bps BETWEEN 0 AND 9007199254740991
        ),
      raw_sample_count INTEGER NOT NULL DEFAULT 0
        CHECK (
          typeof(raw_sample_count) = 'integer'
          AND raw_sample_count BETWEEN 0 AND 9007199254740991
        ),
      history_dropped_count INTEGER NOT NULL DEFAULT 0
        CHECK (
          typeof(history_dropped_count) = 'integer'
          AND history_dropped_count BETWEEN 0 AND 9007199254740991
        ),
      history_truncated_at INTEGER
        CHECK (
          history_truncated_at IS NULL
          OR (
            typeof(history_truncated_at) = 'integer'
            AND history_truncated_at BETWEEN 1 AND 9007199254740991
          )
        ),
      updated_at INTEGER NOT NULL
        CHECK (
          typeof(updated_at) = 'integer'
          AND updated_at BETWEEN 1 AND 9007199254740991
        ),
      FOREIGN KEY (motrix_id)
        REFERENCES tasks(motrix_id) ON DELETE CASCADE
    ) WITHOUT ROWID`,
  },
  {
    name: 'task_history_events',
    sql: `CREATE TABLE task_history_events (
      event_id INTEGER PRIMARY KEY,
      motrix_id TEXT NOT NULL,
      event_ordinal INTEGER NOT NULL
        CHECK (
          typeof(event_ordinal) = 'integer'
          AND event_ordinal BETWEEN 1 AND 9007199254740991
        ),
      event_key TEXT NOT NULL
        CHECK (
          typeof(event_key) = 'text'
          AND length(event_key) BETWEEN 1 AND 256
        ),
      kind TEXT NOT NULL CHECK (kind IN (
        'added',
        'started',
        'paused',
        'resumed',
        'stage_changed',
        'completed',
        'failed',
        'observed_state'
      )),
      from_status TEXT CHECK (
        from_status IS NULL OR from_status IN (
          'queued','fetching_metadata','metadata_ready','downloading',
          'finalizing','seeding','paused','completed','error','removed'
        )
      ),
      to_status TEXT NOT NULL CHECK (to_status IN (
        'queued','fetching_metadata','metadata_ready','downloading',
        'finalizing','seeding','paused','completed','error','removed'
      )),
      occurred_at INTEGER NOT NULL
        CHECK (
          typeof(occurred_at) = 'integer'
          AND occurred_at BETWEEN 1 AND 9007199254740991
        ),
      accuracy TEXT NOT NULL DEFAULT 'exact'
        CHECK (accuracy IN ('exact', 'recovered')),
      error_code TEXT
        CHECK (
          error_code IS NULL
          OR (
            typeof(error_code) = 'text'
            AND length(error_code) BETWEEN 1 AND 128
          )
        ),
      error_message TEXT
        CHECK (
          error_message IS NULL
          OR (
            typeof(error_message) = 'text'
            AND length(error_message) BETWEEN 1 AND 2048
          )
        ),
      error_detail_key TEXT
        CHECK (
          error_detail_key IS NULL
          OR (
            typeof(error_detail_key) = 'text'
            AND length(error_detail_key) BETWEEN 1 AND 128
          )
        ),
      error_detail_params TEXT
        CHECK (
          error_detail_params IS NULL
          OR (
            typeof(error_detail_params) = 'text'
            AND length(error_detail_params) BETWEEN 1 AND 2048
          )
        ),
      FOREIGN KEY (motrix_id)
        REFERENCES tasks(motrix_id) ON DELETE CASCADE,
      UNIQUE (motrix_id, event_key),
      UNIQUE (motrix_id, event_ordinal)
    )`,
  },
  {
    name: 'task_transfer_samples',
    sql: `CREATE TABLE task_transfer_samples (
      motrix_id TEXT NOT NULL,
      sampled_at INTEGER NOT NULL
        CHECK (
          typeof(sampled_at) = 'integer'
          AND sampled_at BETWEEN 1 AND 9007199254740991
        ),
      download_bps INTEGER NOT NULL
        CHECK (
          typeof(download_bps) = 'integer'
          AND download_bps BETWEEN 0 AND 9007199254740991
        ),
      upload_bps INTEGER NOT NULL
        CHECK (
          typeof(upload_bps) = 'integer'
          AND upload_bps BETWEEN 0 AND 9007199254740991
        ),
      flags INTEGER NOT NULL DEFAULT 0
        CHECK (
          typeof(flags) = 'integer'
          AND flags BETWEEN 0 AND 2147483647
        ),
      PRIMARY KEY (motrix_id, sampled_at),
      FOREIGN KEY (motrix_id)
        REFERENCES tasks(motrix_id) ON DELETE CASCADE
    ) WITHOUT ROWID`,
  },
  {
    name: 'task_occurrences',
    sql: `CREATE TABLE task_occurrences (
      occurrence_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      task_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      cause TEXT,
      revision INTEGER,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      dispatched_at INTEGER
    )`,
  },
  {
    name: 'notification_occurrences',
    sql: `CREATE TABLE notification_occurrences (
      source_key TEXT PRIMARY KEY,
      task_id TEXT,
      created_at INTEGER NOT NULL
    )`,
  },
  {
    name: 'idx_notification_occurrences_task',
    sql: `CREATE INDEX idx_notification_occurrences_task
        ON notification_occurrences(task_id)`,
  },
  {
    name: 'notifications',
    sql: `CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      source_key TEXT,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      title_key TEXT NOT NULL,
      title_params TEXT,
      body_key TEXT,
      body_params TEXT,
      task_id TEXT,
      created_at INTEGER NOT NULL,
      read_at INTEGER
    )`,
  },
  {
    name: 'idx_notifications_created',
    sql: `CREATE INDEX idx_notifications_created
        ON notifications(created_at)`,
  },
  {
    // F3 (Codex adversarial-review fix wave): hard backstop against a
    // duplicate display row for the same sourceKey. Unreachable today
    // because the startup drain is macrotask-atomic, but a single real-I/O
    // await introduced into any consumer would open the race; a partial
    // unique index costs nothing and closes it unconditionally.
    // Baseline edit — project is unreleased, no migration needed (dev DBs
    // get wiped).
    name: 'idx_notifications_source_key',
    sql: `CREATE UNIQUE INDEX idx_notifications_source_key
        ON notifications(source_key) WHERE source_key IS NOT NULL`,
  },
]

export const v3 = {
  version: 3,
  up(db: Database.Database): void {
    for (const object of V3_SCHEMA_OBJECTS) {
      db.exec(object.sql)
    }
  },
}
