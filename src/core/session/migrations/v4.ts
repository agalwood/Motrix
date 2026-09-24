import type Database from 'better-sqlite3'
import type { SchemaObjectDefinition } from './v1'

export const V4_SCHEMA_OBJECTS: readonly SchemaObjectDefinition[] = [
  {
    name: 'plugin_finalize_journals',
    sql: `CREATE TABLE plugin_finalize_journals (
      plan_id TEXT PRIMARY KEY
        CHECK (typeof(plan_id) = 'text' AND length(plan_id) BETWEEN 1 AND 128),
      task_id TEXT NOT NULL UNIQUE
        CHECK (typeof(task_id) = 'text' AND length(task_id) BETWEEN 1 AND 256),
      phase TEXT NOT NULL CHECK (phase IN (
        'prepared','target_staged','source_preserved','target_installed',
        'db_committed','cleaned','quarantined'
      )),
      plan_json TEXT NOT NULL
        CHECK (typeof(plan_json) = 'text' AND json_valid(plan_json)),
      source_identity_json TEXT NOT NULL
        CHECK (typeof(source_identity_json) = 'text' AND json_valid(source_identity_json)),
      target_identity_json TEXT
        CHECK (
          target_identity_json IS NULL
          OR (typeof(target_identity_json) = 'text' AND json_valid(target_identity_json))
        ),
      quarantine_reason TEXT
        CHECK (
          quarantine_reason IS NULL
          OR (typeof(quarantine_reason) = 'text' AND length(quarantine_reason) BETWEEN 1 AND 256)
        ),
      created_at INTEGER NOT NULL
        CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 1 AND 9007199254740991),
      updated_at INTEGER NOT NULL
        CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN 1 AND 9007199254740991),
      CHECK (
        (phase = 'quarantined' AND quarantine_reason IS NOT NULL)
        OR (phase <> 'quarantined' AND quarantine_reason IS NULL)
      )
    ) WITHOUT ROWID`,
  },
  {
    name: 'idx_plugin_finalize_journals_phase',
    sql: `CREATE INDEX idx_plugin_finalize_journals_phase
        ON plugin_finalize_journals(phase, updated_at)`,
  },
  {
    name: 'plugin_post_deliveries',
    sql: `CREATE TABLE plugin_post_deliveries (
      delivery_id TEXT PRIMARY KEY
        CHECK (typeof(delivery_id) = 'text' AND length(delivery_id) BETWEEN 1 AND 128),
      deduplication_key TEXT NOT NULL UNIQUE
        CHECK (
          typeof(deduplication_key) = 'text'
          AND length(deduplication_key) = 64
          AND deduplication_key NOT GLOB '*[^0-9a-f]*'
        ),
      occurrence_id TEXT NOT NULL
        CHECK (typeof(occurrence_id) = 'text' AND length(occurrence_id) BETWEEN 1 AND 128),
      hook TEXT NOT NULL CHECK (hook IN ('afterComplete','onError')),
      task_id TEXT NOT NULL
        CHECK (typeof(task_id) = 'text' AND length(task_id) BETWEEN 1 AND 256),
      occurred_at INTEGER NOT NULL
        CHECK (typeof(occurred_at) = 'integer' AND occurred_at BETWEEN 0 AND 9007199254740991),
      plugin_id TEXT NOT NULL
        CHECK (typeof(plugin_id) = 'text' AND length(plugin_id) BETWEEN 1 AND 256),
      plugin_version TEXT NOT NULL
        CHECK (typeof(plugin_version) = 'text' AND length(plugin_version) BETWEEN 1 AND 128),
      executable_digest TEXT NOT NULL
        CHECK (
          typeof(executable_digest) = 'text'
          AND length(executable_digest) = 64
          AND executable_digest NOT GLOB '*[^0-9a-f]*'
        ),
      created_generation INTEGER NOT NULL
        CHECK (typeof(created_generation) = 'integer' AND created_generation BETWEEN 0 AND 9007199254740991),
      effective_permissions_json TEXT NOT NULL
        CHECK (
          typeof(effective_permissions_json) = 'text'
          AND json_valid(effective_permissions_json)
          AND json_type(effective_permissions_json) = 'array'
        ),
      required_permissions_json TEXT NOT NULL
        CHECK (
          typeof(required_permissions_json) = 'text'
          AND json_valid(required_permissions_json)
          AND json_type(required_permissions_json) = 'array'
        ),
      payload_json TEXT NOT NULL
        CHECK (typeof(payload_json) = 'text' AND json_valid(payload_json)),
      payload_bytes INTEGER NOT NULL
        CHECK (typeof(payload_bytes) = 'integer' AND payload_bytes BETWEEN 0 AND 2097152),
      reserved_bytes INTEGER NOT NULL
        CHECK (typeof(reserved_bytes) = 'integer' AND reserved_bytes BETWEEN 516 AND 4194304),
      compact INTEGER NOT NULL DEFAULT 0 CHECK (compact IN (0, 1)),
      status TEXT NOT NULL CHECK (status IN (
        'pending','delivering','delivered','dead_letter','superseded'
      )),
      attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(attempt_count) = 'integer' AND attempt_count BETWEEN 0 AND 32),
      next_attempt_at INTEGER NOT NULL
        CHECK (typeof(next_attempt_at) = 'integer' AND next_attempt_at BETWEEN 1 AND 9007199254740991),
      lease_owner TEXT
        CHECK (
          lease_owner IS NULL
          OR (typeof(lease_owner) = 'text' AND length(lease_owner) BETWEEN 1 AND 128)
        ),
      lease_expires_at INTEGER
        CHECK (
          lease_expires_at IS NULL
          OR (typeof(lease_expires_at) = 'integer' AND lease_expires_at BETWEEN 1 AND 9007199254740991)
        ),
      permanent_reason TEXT
        CHECK (
          permanent_reason IS NULL
          OR (typeof(permanent_reason) = 'text' AND length(permanent_reason) BETWEEN 1 AND 128)
        ),
      created_at INTEGER NOT NULL
        CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 1 AND 9007199254740991),
      updated_at INTEGER NOT NULL
        CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN 1 AND 9007199254740991),
      delivered_at INTEGER
        CHECK (
          delivered_at IS NULL
          OR (typeof(delivered_at) = 'integer' AND delivered_at BETWEEN 1 AND 9007199254740991)
        ),
      receipt_invocation_id TEXT
        CHECK (
          receipt_invocation_id IS NULL
          OR (typeof(receipt_invocation_id) = 'text' AND length(receipt_invocation_id) BETWEEN 1 AND 128)
        ),
      last_error_code TEXT
        CHECK (
          last_error_code IS NULL
          OR (typeof(last_error_code) = 'text' AND length(last_error_code) BETWEEN 1 AND 128)
        ),
      last_error_message TEXT
        CHECK (
          last_error_message IS NULL
          OR (typeof(last_error_message) = 'text' AND length(last_error_message) BETWEEN 1 AND 1024)
        ),
      UNIQUE (occurrence_id, hook, plugin_id, plugin_version, executable_digest),
      CHECK (
        (status = 'delivering' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (status <> 'delivering' AND lease_owner IS NULL AND lease_expires_at IS NULL)
      ),
      CHECK (
        (status IN ('dead_letter','superseded') AND permanent_reason IS NOT NULL)
        OR (status NOT IN ('dead_letter','superseded') AND permanent_reason IS NULL)
      ),
      CHECK (
        (status = 'delivered' AND delivered_at IS NOT NULL)
        OR (status <> 'delivered' AND delivered_at IS NULL)
      ),
      CHECK (
        (status = 'delivered' AND receipt_invocation_id IS NOT NULL)
        OR (status <> 'delivered' AND receipt_invocation_id IS NULL)
      )
    ) WITHOUT ROWID`,
  },
  {
    name: 'idx_plugin_post_deliveries_claim',
    sql: `CREATE INDEX idx_plugin_post_deliveries_claim
        ON plugin_post_deliveries(status, next_attempt_at, plugin_id, created_at)`,
  },
  {
    name: 'idx_plugin_post_deliveries_task',
    sql: `CREATE INDEX idx_plugin_post_deliveries_task
        ON plugin_post_deliveries(task_id, created_at)`,
  },
  {
    name: 'plugin_post_breakers',
    sql: `CREATE TABLE plugin_post_breakers (
      plugin_id TEXT PRIMARY KEY
        CHECK (typeof(plugin_id) = 'text' AND length(plugin_id) BETWEEN 1 AND 256),
      state TEXT NOT NULL CHECK (state IN ('closed','open','half_open')),
      failure_count INTEGER NOT NULL
        CHECK (typeof(failure_count) = 'integer' AND failure_count BETWEEN 0 AND 100),
      window_started_at INTEGER
        CHECK (
          window_started_at IS NULL
          OR (typeof(window_started_at) = 'integer' AND window_started_at BETWEEN 1 AND 9007199254740991)
        ),
      open_until INTEGER
        CHECK (
          open_until IS NULL
          OR (typeof(open_until) = 'integer' AND open_until BETWEEN 1 AND 9007199254740991)
        ),
      probe_token TEXT
        CHECK (
          probe_token IS NULL
          OR (typeof(probe_token) = 'text' AND length(probe_token) BETWEEN 1 AND 128)
        ),
      probe_lease_expires_at INTEGER
        CHECK (
          probe_lease_expires_at IS NULL
          OR (typeof(probe_lease_expires_at) = 'integer' AND probe_lease_expires_at BETWEEN 1 AND 9007199254740991)
        ),
      updated_at INTEGER NOT NULL
        CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN 1 AND 9007199254740991),
      CHECK (
        (state = 'closed' AND open_until IS NULL AND probe_token IS NULL AND probe_lease_expires_at IS NULL)
        OR (state = 'open' AND open_until IS NOT NULL AND probe_token IS NULL AND probe_lease_expires_at IS NULL)
        OR (state = 'half_open' AND open_until IS NULL AND probe_token IS NOT NULL AND probe_lease_expires_at IS NOT NULL)
      )
    ) WITHOUT ROWID`,
  },
  {
    name: 'plugin_post_quota_ledger',
    sql: `CREATE TABLE plugin_post_quota_ledger (
      scope_key TEXT PRIMARY KEY
        CHECK (typeof(scope_key) = 'text' AND length(scope_key) BETWEEN 1 AND 320),
      active_rows INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(active_rows) = 'integer' AND active_rows BETWEEN 0 AND 10000),
      active_bytes INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(active_bytes) = 'integer' AND active_bytes BETWEEN 0 AND 536870912),
      terminal_rows INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(terminal_rows) = 'integer' AND terminal_rows BETWEEN 0 AND 40000),
      terminal_bytes INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(terminal_bytes) = 'integer' AND terminal_bytes BETWEEN 0 AND 41943040),
      updated_at INTEGER NOT NULL
        CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN 1 AND 9007199254740991)
    ) WITHOUT ROWID`,
  },
  {
    name: 'plugin_post_quota_buckets',
    sql: `CREATE TABLE plugin_post_quota_buckets (
      bucket_key TEXT PRIMARY KEY
        CHECK (typeof(bucket_key) = 'text' AND length(bucket_key) BETWEEN 1 AND 512),
      plugin_id TEXT NOT NULL
        CHECK (typeof(plugin_id) = 'text' AND length(plugin_id) BETWEEN 1 AND 256),
      hook TEXT NOT NULL CHECK (hook IN ('afterComplete','onError','all')),
      reason TEXT NOT NULL
        CHECK (typeof(reason) = 'text' AND length(reason) BETWEEN 1 AND 128),
      bucket_day INTEGER NOT NULL
        CHECK (typeof(bucket_day) = 'integer' AND bucket_day BETWEEN -1 AND 9007199254740991),
      rejected_count INTEGER NOT NULL
        CHECK (typeof(rejected_count) = 'integer' AND rejected_count BETWEEN 1 AND 9007199254740991),
      first_occurrence_id TEXT NOT NULL
        CHECK (typeof(first_occurrence_id) = 'text' AND length(first_occurrence_id) BETWEEN 1 AND 128),
      last_occurrence_id TEXT NOT NULL
        CHECK (typeof(last_occurrence_id) = 'text' AND length(last_occurrence_id) BETWEEN 1 AND 128),
      first_at INTEGER NOT NULL
        CHECK (typeof(first_at) = 'integer' AND first_at BETWEEN 1 AND 9007199254740991),
      last_at INTEGER NOT NULL
        CHECK (typeof(last_at) = 'integer' AND last_at BETWEEN 1 AND 9007199254740991),
      CHECK (first_at <= last_at)
    ) WITHOUT ROWID`,
  },
  {
    name: 'idx_plugin_post_quota_buckets_rollup',
    sql: `CREATE INDEX idx_plugin_post_quota_buckets_rollup
        ON plugin_post_quota_buckets(plugin_id, reason, bucket_day)`,
  },
] as const

export const v4 = {
  version: 4,
  up(db: Database.Database): void {
    for (const object of V4_SCHEMA_OBJECTS) {
      db.exec(object.sql)
    }
  },
}
