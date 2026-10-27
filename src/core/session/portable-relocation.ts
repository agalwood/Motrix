import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type Database from 'better-sqlite3'
import { z } from 'zod'

export function isWithinPortableRoot(value: string, root: string): boolean {
  if (!path.win32.isAbsolute(value)) return false
  const relative = path.win32.relative(root, value)
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith('..\\') &&
      !path.win32.isAbsolute(relative))
  )
}

/** Input must be an original path from the immutable relocation snapshot. */
export function relocatePortablePath(
  value: string,
  roots: readonly string[],
  currentRoot: string
): string {
  for (const root of roots) {
    if (isWithinPortableRoot(value, root))
      return path.win32.join(currentRoot, path.win32.relative(root, value))
  }
  return value
}

/** Only used for settings fields whose entire value is a path or a path list. */
export function relocatePortableValue(
  value: unknown,
  roots: readonly string[],
  currentRoot: string
): unknown {
  if (typeof value === 'string')
    return relocatePortablePath(value, roots, currentRoot)
  if (Array.isArray(value))
    return value.map((item) => relocatePortableValue(item, roots, currentRoot))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        relocatePortableValue(item, roots, currentRoot),
      ])
    )
  }
  return value
}

const PAYLOAD_PATH_KEYS = new Set([
  'path',
  'paths',
  'saveDir',
  'diskPath',
  'finalPath',
  'torrentMetaPath',
  'metadataDir',
  'mediaMetaPath',
  'workspacePath',
  'sourcePath',
  'targetPath',
  'privateTargetPath',
  'rollbackPath',
  'artifactPath',
  'quarantinePath',
  'directory',
  'rootPath',
  'dataPath',
  'backupRoot',
  'snapshotDir',
  'controlBackupPath',
  'cleanupArtifactPaths',
  'artifactPaths',
  'outputRoot',
  'outputPath',
])
const OPAQUE_KEYS = new Set([
  'headers',
  'requestHeaders',
  'cookies',
  'config',
  'secrets',
  'script',
  'requestModifiers',
  'resourceValidator',
  'sourceMeta',
  'source_meta',
])

/** Keep credentials, request metadata and plugin configuration opaque. */
function mapPayloadPaths(
  value: unknown,
  map: (value: string) => string,
  pathField = false
): unknown {
  if (typeof value === 'string') return pathField ? map(value) : value
  if (Array.isArray(value))
    return value.map((item) => mapPayloadPaths(item, map, pathField))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        OPAQUE_KEYS.has(key)
          ? item
          : mapPayloadPaths(item, map, PAYLOAD_PATH_KEYS.has(key)),
      ])
    )
  }
  return value
}

export function portablePayloadPaths(value: unknown): string[] {
  const paths: string[] = []
  mapPayloadPaths(value, (candidate) => {
    if (path.win32.isAbsolute(candidate)) paths.push(candidate)
    return candidate
  })
  return paths
}

const PATH_COLUMNS: Record<string, readonly string[]> = {
  tasks: ['save_dir', 'final_path', 'torrent_meta_path'],
  task_instances: ['disk_path', 'payload'],
  task_files: ['path'],
  plugin_finalize_journals: [
    'plan_json',
    'source_identity_json',
    'target_identity_json',
  ],
  plugin_post_deliveries: ['payload_json'],
}
const EVIDENCE_COLUMNS: Record<string, readonly string[]> = {
  tasks: ['agg_status'],
  task_instances: ['motrix_id', 'status', 'transition_phase'],
}
const JSON_COLUMNS = new Set([
  'error_detail_params',
  'payload',
  'plan_json',
  'source_identity_json',
  'target_identity_json',
  'payload_json',
])
const sqliteValueSchema = z.union([z.string(), z.number(), z.null()])
export const portableDatabaseSnapshotSchema = z.record(
  z.string().refine((name) => Object.hasOwn(PATH_COLUMNS, name)),
  z.array(z.record(z.string(), sqliteValueSchema))
)
export type PortableDatabaseSnapshot = z.infer<
  typeof portableDatabaseSnapshotSchema
>
type SqliteValue = z.infer<typeof sqliteValueSchema>
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

function tableColumns(db: Database.Database, table: string) {
  const schema = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string
    pk: number
  }>
  const keys = schema
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name)
  const columns = PATH_COLUMNS[table].filter((name) =>
    schema.some((column) => column.name === name)
  )
  const evidence = (EVIDENCE_COLUMNS[table] ?? []).filter((name) =>
    schema.some((column) => column.name === name)
  )
  return { keys, columns, evidence }
}

export function capturePortableDatabase(
  db: Database.Database,
  tables: readonly string[] = Object.keys(PATH_COLUMNS)
): PortableDatabaseSnapshot {
  const snapshot: PortableDatabaseSnapshot = {}
  for (const table of tables) {
    if (!Object.hasOwn(PATH_COLUMNS, table))
      throw new Error('Unknown portable snapshot table')
    const { keys, columns, evidence } = tableColumns(db, table)
    if (!keys.length || !columns.length) continue
    const names = [...new Set([...keys, ...columns, ...evidence])]
    snapshot[table] = db
      .prepare(`SELECT ${names.map(quote).join(', ')} FROM ${table}`)
      .all() as Record<string, SqliteValue>[]
  }
  return snapshot
}

function mapColumn(
  name: string,
  value: SqliteValue,
  sourceRoot: string,
  targetRoot: string
): SqliteValue {
  if (typeof value !== 'string') return value
  if (JSON_COLUMNS.has(name))
    return JSON.stringify(
      mapPayloadPaths(JSON.parse(value), (item) =>
        relocatePortablePath(item, [sourceRoot], targetRoot)
      )
    )
  return relocatePortablePath(value, [sourceRoot], targetRoot)
}
function equivalentColumn(
  name: string,
  left: SqliteValue,
  right: SqliteValue
): boolean {
  if (
    JSON_COLUMNS.has(name) &&
    typeof left === 'string' &&
    typeof right === 'string'
  )
    return isDeepStrictEqual(JSON.parse(left), JSON.parse(right))
  return left === right
}

/** Replay from original values, never from already-rebased rows. All tables commit together. */
export function relocatePortableDatabase(
  db: Database.Database,
  snapshot: PortableDatabaseSnapshot,
  sourceRoot: string,
  currentRoot: string,
  attemptedRoots: readonly string[] = []
): void {
  db.transaction(() => {
    for (const table of Object.keys(PATH_COLUMNS)) {
      const rows = snapshot[table]
      if (!rows?.length) continue
      const { keys, columns } = tableColumns(db, table)
      if (!keys.length || !columns.length)
        throw new Error('Portable relocation schema changed')
      const where = keys.map((name) => `${quote(name)} = ?`).join(' AND ')
      const read = db.prepare(
        `SELECT ${columns.map(quote).join(', ')} FROM ${table} WHERE ${where}`
      )
      for (const row of rows) {
        const keyValues = keys.map((name) => row[name])
        const current = read.get(...keyValues) as
          | Record<string, SqliteValue>
          | undefined
        if (!current) throw new Error('Portable relocation record changed')
        const changes: Array<[string, SqliteValue]> = []
        for (const name of columns) {
          const original = row[name]
          if (original === undefined)
            throw new Error('Portable relocation snapshot is incomplete')
          const mapped = mapColumn(name, original, sourceRoot, currentRoot)
          const allowed = [
            original,
            ...attemptedRoots.map((root) =>
              mapColumn(name, original, sourceRoot, root)
            ),
          ]
          if (allowed.every((value) => equivalentColumn(name, value, mapped)))
            continue
          if (
            !allowed.some((value) =>
              equivalentColumn(name, value, current[name])
            )
          )
            throw new Error(
              'Portable relocation record was edited during recovery'
            )
          if (!equivalentColumn(name, current[name], mapped))
            changes.push([name, mapped])
        }
        if (changes.length)
          db.prepare(
            `UPDATE ${table} SET ${changes.map(([name]) => `${quote(name)} = ?`).join(', ')} WHERE ${where}`
          ).run(...changes.map(([, value]) => value), ...keyValues)
      }
    }
  })()
}
