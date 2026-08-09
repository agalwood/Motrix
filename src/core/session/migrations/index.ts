import type Database from 'better-sqlite3'
import {
  ACTIVITY_SCHEMA_OBJECTS,
  V1_INHERITED_SCHEMA_OBJECTS,
  V1_TASK_SCHEMA_OBJECTS,
  v1,
} from './v1'
import { V2_TASK_SCHEMA_OBJECTS, v2 } from './v2'
import { V3_SCHEMA_OBJECTS, v3 } from './v3'

interface Migration {
  version: number
  up(db: Database.Database): void
}

// v1 is the Plan A canonical schema; v2 widens agg_status/status
// CHECK constraints to admit the `metadata_ready` value introduced
// as a Plan B follow-up (magnet metadata resolved + awaiting user
// file selection — distinct from "still fetching metadata" so the
// Downloads pill can say "Ready" instead of the misleading
// "Fetching"). v3 adds task-owned Inspector Activity persistence.
const MIGRATIONS: Migration[] = [v1, v2, v3]

const HIGHEST_KNOWN_VERSION = MIGRATIONS.reduce(
  (max, m) => (m.version > max ? m.version : max),
  0
)

export class SchemaVersionTooNewError extends Error {
  constructor(
    public readonly currentVersion: number,
    public readonly highestKnownVersion: number,
    public readonly dbPath: string
  ) {
    super(
      `Database schema version ${currentVersion} is newer than this ` +
        `build supports (highest known: v${highestKnownVersion}). This ` +
        `usually means the database file predates the Plan A rewrite ` +
        `and still contains the legacy task_metadata schema.\n` +
        `\n` +
        `Action: delete the database file and restart the app to ` +
        `recreate it on the v1 schema.\n` +
        `  rm '${dbPath}'\n` +
        `\n` +
        `If you need the data, downgrade to the pre-Plan-A build first.`
    )
    this.name = 'SchemaVersionTooNewError'
  }
}

export class StaleSchemaError extends Error {
  constructor(
    public readonly reason:
      | 'legacy_table_present'
      | 'new_tables_missing'
      | 'transfer_tables_missing'
      | 'inherited_schema_missing'
      | 'canonical_task_columns_missing'
      | 'activity_schema_missing'
      | 'inspector_activity_schema_missing'
      | 'foreign_key_violation',
    public readonly dbPath: string
  ) {
    const detail =
      reason === 'legacy_table_present'
        ? 'legacy table `task_metadata` is still present'
        : reason === 'new_tables_missing'
          ? 'expected tables `tasks`/`task_instances` are missing'
          : reason === 'transfer_tables_missing'
            ? 'expected tables `transfer_totals`/`transfer_buckets` are missing'
            : reason === 'inherited_schema_missing'
              ? 'expected canonical schema-version, plugin-state, and transfer tables, columns, constraints, primary keys, indexes, and trigger policy are invalid'
              : reason === 'canonical_task_columns_missing'
                ? 'expected canonical task, task-instance, and task-file ' +
                  'columns (including `task_type`, `finished_at`, ' +
                  '`error_message`, `error_code`, `error_detail_key`, ' +
                  '`error_detail_params`, and `diagnosis_revision`), order, ' +
                  'constraints, foreign keys, and indexes are invalid'
                : reason === 'activity_schema_missing'
                  ? 'expected Dashboard activity tables, columns, singleton metadata, ' +
                    'foreign-key/trigger policy, or the time-first activity index are invalid'
                  : reason === 'inspector_activity_schema_missing'
                    ? 'expected canonical schema objects (task inspector ' +
                      'activity and notification tables, constraints, or ' +
                      'indexes) are invalid'
                    : 'the canonical schema contains foreign-key violations'
    super(
      `The versioned database schema is incompatible with this build: ` +
        `${detail}. ` +
        `This unpublished build updates the canonical v1 schema directly, ` +
        `so an existing local development database can have a valid version ` +
        `marker while its substantive tables are stale.\n` +
        `\n` +
        `Action: delete the database file and restart the app to ` +
        `recreate it on the current v1 schema.\n` +
        `  rm '${dbPath}'`
    )
    this.name = 'StaleSchemaError'
  }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function hasExactSchemaObjects(
  db: Database.Database,
  objects: readonly { name: string; sql: string }[]
): boolean {
  const rows = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE name IN (${objects.map(() => '?').join(', ')})`
    )
    .all(...objects.map((object) => object.name)) as Array<{
    name: string
    sql: string | null
  }>
  const sqlByName = new Map(rows.map((row) => [row.name, row.sql ?? '']))
  return objects.every(
    (object) =>
      normalizeSql(sqlByName.get(object.name) ?? '') ===
      normalizeSql(object.sql)
  )
}

const SCHEMA_VERSION_OBJECTS = [
  {
    name: 'schema_version',
    sql: `CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`,
  },
] as const

const INHERITED_SCHEMA_OBJECTS = [
  ...SCHEMA_VERSION_OBJECTS,
  ...V1_INHERITED_SCHEMA_OBJECTS,
] as const

const INHERITED_TABLES = INHERITED_SCHEMA_OBJECTS.map((object) => object.name)

function hasNoExplicitIndexesOrTriggers(
  db: Database.Database,
  tables: readonly string[]
): boolean {
  return (
    db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE tbl_name IN (${tables.map(() => '?').join(', ')})
           AND (
             type = 'trigger'
             OR (type = 'index' AND sql IS NOT NULL)
           )`
      )
      .all(...tables).length === 0
  )
}

function hasExactCanonicalInheritedSchema(db: Database.Database): boolean {
  if (!hasExactSchemaObjects(db, INHERITED_SCHEMA_OBJECTS)) {
    return false
  }

  return hasNoExplicitIndexesOrTriggers(db, INHERITED_TABLES)
}

function assertCanonicalInheritedSchema(db: Database.Database): void {
  if (!hasExactCanonicalInheritedSchema(db)) {
    throw new StaleSchemaError(
      'inherited_schema_missing',
      (db as unknown as { name: string }).name
    )
  }
}

function assertCanonicalSchemaVersion(db: Database.Database): void {
  if (
    !hasExactSchemaObjects(db, SCHEMA_VERSION_OBJECTS) ||
    !hasNoExplicitIndexesOrTriggers(db, ['schema_version'])
  ) {
    throw new StaleSchemaError(
      'inherited_schema_missing',
      (db as unknown as { name: string }).name
    )
  }
}

const CANONICAL_TASK_TABLES = ['tasks', 'task_instances', 'task_files'] as const

function hasExactCanonicalTaskSchema(
  db: Database.Database,
  objects: readonly { name: string; sql: string }[]
): boolean {
  if (!hasExactSchemaObjects(db, objects)) {
    return false
  }

  const expectedNames = new Set(objects.map((object) => object.name))
  const explicitIndexesAndTriggers = db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE tbl_name IN (${CANONICAL_TASK_TABLES.map(() => '?').join(', ')})
         AND (
           type = 'trigger'
           OR (type = 'index' AND sql IS NOT NULL)
         )`
    )
    .all(...CANONICAL_TASK_TABLES) as Array<{ name: string }>

  return explicitIndexesAndTriggers.every((object) =>
    expectedNames.has(object.name)
  )
}

function assertCanonicalTaskSchema(
  db: Database.Database,
  objects: readonly { name: string; sql: string }[]
): void {
  if (!hasExactCanonicalTaskSchema(db, objects)) {
    throw new StaleSchemaError(
      'canonical_task_columns_missing',
      (db as unknown as { name: string }).name
    )
  }
}

function validateCanonicalV3(db: Database.Database): void {
  const dbPath = (db as unknown as { name: string }).name
  assertCanonicalInheritedSchema(db)
  assertCanonicalTaskSchema(db, V2_TASK_SCHEMA_OBJECTS)

  if (!hasExactSchemaObjects(db, V3_SCHEMA_OBJECTS)) {
    throw new StaleSchemaError('inspector_activity_schema_missing', dbPath)
  }

  const unexpectedIndexes = [
    'task_inspector_activity',
    'task_history_events',
    'task_transfer_samples',
  ].flatMap((table) =>
    (
      db.prepare(`PRAGMA index_list(${table})`).all() as Array<{
        name: string
        origin: string
      }>
    ).filter((index) => index.origin === 'c')
  )
  const unexpectedTriggers = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'trigger'
         AND tbl_name IN (
           'task_inspector_activity',
           'task_history_events',
           'task_transfer_samples'
         )`
    )
    .all()
  if (unexpectedIndexes.length > 0 || unexpectedTriggers.length > 0) {
    throw new StaleSchemaError('inspector_activity_schema_missing', dbPath)
  }

  if ((db.pragma('foreign_key_check') as unknown[]).length > 0) {
    throw new StaleSchemaError('foreign_key_violation', dbPath)
  }
}

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `)
  assertCanonicalSchemaVersion(db)
  const row = db
    .prepare('SELECT MAX(version) AS v FROM schema_version')
    .get() as { v: number | null } | undefined
  const current = row?.v ?? 0

  // Guard A (Codex finding #7): schema_version newer than this build
  // knows about. The default migration loop would skip everything,
  // then the app would crash with cryptic "no such table" errors.
  if (current > HIGHEST_KNOWN_VERSION) {
    throw new SchemaVersionTooNewError(
      current,
      HIGHEST_KNOWN_VERSION,
      (db as unknown as { name: string }).name
    )
  }

  // Guard B (Codex finding #8): version-only check is insufficient.
  // A pre-Plan-A build also wrote schema_version=1 for its legacy v1
  // (the original `task_metadata` schema), and a half-recovered DB
  // can have schema_version >= 1 without the new tables present.
  // Run this BEFORE the migration loop so we don't try to apply v2+
  // on top of a missing baseline (v2's ALTER/INSERT would crash with
  // a cryptic "no such table" instead of the StaleSchemaError that
  // tells the user exactly what to do). Fresh DB (current == 0) gets
  // a free pass — v1 below will create the tables.
  if (current > 0) {
    const hasNewSchema =
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'"
        )
        .get() !== undefined &&
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_instances'"
        )
        .get() !== undefined
    const hasTaskFiles =
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_files'"
        )
        .get() !== undefined
    const hasLegacySchema =
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_metadata'"
        )
        .get() !== undefined
    const hasTransferSchema =
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='transfer_totals'"
        )
        .get() !== undefined &&
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='transfer_buckets'"
        )
        .get() !== undefined
    const dbPath = (db as unknown as { name: string }).name
    if (hasLegacySchema) {
      throw new StaleSchemaError('legacy_table_present', dbPath)
    }
    if (!hasNewSchema) {
      throw new StaleSchemaError('new_tables_missing', dbPath)
    }
    const taskColumns = new Set(
      (
        db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
      ).map((column) => column.name)
    )
    if (
      !taskColumns.has('task_type') ||
      !taskColumns.has('finished_at') ||
      !taskColumns.has('error_message') ||
      !taskColumns.has('error_code') ||
      !taskColumns.has('error_detail_key') ||
      !taskColumns.has('error_detail_params') ||
      !taskColumns.has('diagnosis_revision')
    ) {
      throw new StaleSchemaError('canonical_task_columns_missing', dbPath)
    }
    if (!hasTransferSchema) {
      throw new StaleSchemaError('transfer_tables_missing', dbPath)
    }
    if (!hasTaskFiles) {
      throw new StaleSchemaError('new_tables_missing', dbPath)
    }
    if (current >= 2) {
      const statusSchemas = db
        .prepare(
          `SELECT name, sql FROM sqlite_master
           WHERE type = 'table' AND name IN ('tasks', 'task_instances')`
        )
        .all() as Array<{ name: string; sql: string }>
      if (
        statusSchemas.length !== 2 ||
        statusSchemas.some((table) => !table.sql.includes("'metadata_ready'"))
      ) {
        throw new StaleSchemaError('canonical_task_columns_missing', dbPath)
      }
    }
    assertCanonicalTaskSchema(
      db,
      current === 1 ? V1_TASK_SCHEMA_OBJECTS : V2_TASK_SCHEMA_OBJECTS
    )
    assertCanonicalInheritedSchema(db)

    // The canonical DDL text (columns, PK order, CHECK constraints, WITHOUT
    // ROWID, foreign keys, index shape) is compared in one pass against the
    // exact objects v1 creates. Triggers and extra unique indexes live in
    // their own sqlite_master rows, and singleton VALUES are data, so those
    // three checks cannot come from the DDL comparison.
    const hasCanonicalActivityObjects = hasExactSchemaObjects(
      db,
      ACTIVITY_SCHEMA_OBJECTS
    )

    const activityTriggers = db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'trigger'
           AND tbl_name IN ('task_activity_events', 'task_activity_meta')`
      )
      .all()
    const activityIndexes = hasCanonicalActivityObjects
      ? (db.prepare('PRAGMA index_list(task_activity_events)').all() as Array<{
          unique: number
          origin: string
        }>)
      : []
    const hasNoUnexpectedUniqueActivityIndexes = activityIndexes.every(
      (index) => index.unique === 0 || index.origin === 'pk'
    )

    type ActivityMetaRow = {
      id: bigint
      generation: string
      tracking_started_at: bigint
      revision: bigint
      coverage_gap_at: bigint | null
    }
    const activityMetaRows = hasCanonicalActivityObjects
      ? (db
          .prepare(
            `SELECT
               id,
               generation,
               tracking_started_at,
               revision,
               coverage_gap_at
             FROM task_activity_meta`
          )
          .safeIntegers()
          .all() as ActivityMetaRow[])
      : []
    const activityMeta = activityMetaRows[0]
    const hasActivityMeta =
      activityMetaRows.length === 1 &&
      typeof activityMeta?.id === 'bigint' &&
      activityMeta.id === 1n &&
      typeof activityMeta.generation === 'string' &&
      activityMeta.generation.length > 0 &&
      typeof activityMeta.tracking_started_at === 'bigint' &&
      activityMeta.tracking_started_at > 0n &&
      activityMeta.tracking_started_at <= BigInt(Number.MAX_SAFE_INTEGER) &&
      typeof activityMeta.revision === 'bigint' &&
      activityMeta.revision >= 0n &&
      activityMeta.revision <= BigInt(Number.MAX_SAFE_INTEGER - 2) &&
      (activityMeta.coverage_gap_at === null ||
        (typeof activityMeta.coverage_gap_at === 'bigint' &&
          activityMeta.coverage_gap_at > 0n &&
          activityMeta.coverage_gap_at <= BigInt(Number.MAX_SAFE_INTEGER)))
    if (
      !hasCanonicalActivityObjects ||
      activityTriggers.length !== 0 ||
      !hasNoUnexpectedUniqueActivityIndexes ||
      !hasActivityMeta
    ) {
      throw new StaleSchemaError('activity_schema_missing', dbPath)
    }
  }

  for (const m of MIGRATIONS) {
    if (m.version > current) {
      db.transaction(() => {
        m.up(db)
        db.prepare(
          'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)'
        ).run(m.version, Date.now())
      })()
    }
  }

  validateCanonicalV3(db)
}
