import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  capturePortableDatabase,
  isWithinPortableRoot,
  type PortableDatabaseSnapshot,
  portableDatabaseSnapshotSchema,
  portablePayloadPaths,
  relocatePortableDatabase,
  relocatePortableValue,
} from '@core/session/portable-relocation'
import type Database from 'better-sqlite3'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import { type PortableProfile, PortableProfileError } from './portable-profile'

const rootSchema = z
  .string()
  .refine(
    (value) =>
      path.win32.isAbsolute(value) && path.win32.parse(value).root.length > 1
  )
const settingsSchema = z.record(z.string(), z.unknown()).nullable()
const snapshotSchema = z.object({
  sourceRoot: rootSchema,
  settings: settingsSchema,
  database: portableDatabaseSnapshotSchema,
})
const stateSchema = z.object({
  version: z.literal(1),
  roots: z.array(rootSchema).min(1),
  relocationId: z.uuid().optional(),
  engineResetPending: z.boolean().optional().default(false),
})

/** Engine snapshots contain absolute paths. A new location gets a fresh cache. */
export function portableEngineStateDirectory(profile: PortableProfile): string {
  const location = createHash('sha256')
    .update(path.win32.normalize(profile.root).toLowerCase())
    .digest('hex')
    .slice(0, 20)
  return path.join(profile.userDataDir, 'engine', location)
}

async function readSettings(
  file: string
): Promise<z.infer<typeof settingsSchema>> {
  try {
    return settingsSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
function mappedSettings(
  original: z.infer<typeof settingsSchema>,
  sourceRoot: string,
  targetRoot: string
) {
  const settings = structuredClone(original)
  if (!settings) return settings
  // Opaque plugin credentials/scripts are not path configuration.
  for (const [namespace, fields] of Object.entries({
    app: ['defaultSaveDir', 'directoryPreferences'],
    engine: ['sqlite3DbPath'],
    media: ['ffmpegBinaryPath'],
  })) {
    const group = settings[namespace]
    if (!group || typeof group !== 'object' || Array.isArray(group)) continue
    const record = group as Record<string, unknown>
    for (const field of fields)
      if (field in record)
        record[field] = relocatePortableValue(
          record[field],
          [sourceRoot],
          targetRoot
        )
  }
  return settings
}

/** Retries always replay immutable originals, including after another move. */
export async function relocatePortableProfile(
  profile: PortableProfile,
  database: Database.Database
): Promise<boolean> {
  const statePath = path.join(profile.dataDir, 'portable.json')
  const settingsPath = path.join(profile.userDataDir, 'settings.json')
  let state: z.infer<typeof stateSchema>
  try {
    state = stateSchema.parse(JSON.parse(await readFile(statePath, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new PortableProfileError('Portable location history is invalid', {
        cause: error,
      })
    state = { version: 1, roots: [profile.root], engineResetPending: false }
  }
  const moved =
    Boolean(state.relocationId) ||
    state.roots.some((root) => path.win32.relative(root, profile.root) !== '')
  let snapshot: z.infer<typeof snapshotSchema> | undefined
  let relocationId = state.relocationId
  if (relocationId) {
    snapshot = snapshotSchema.parse(
      JSON.parse(
        await readFile(
          path.join(profile.dataDir, 'relocations', `${relocationId}.json`),
          'utf8'
        )
      )
    )
    if (path.win32.relative(snapshot.sourceRoot, state.roots[0]) !== '')
      throw new PortableProfileError(
        'Portable relocation snapshot does not match its journal'
      )
  } else if (moved) {
    if (state.roots.length !== 1)
      throw new PortableProfileError(
        'Portable relocation originals are missing'
      )
    snapshot = {
      sourceRoot: state.roots[0],
      settings: await readSettings(settingsPath),
      database: capturePortableDatabase(database),
    }
    relocationId = randomUUID()
    const directory = path.join(profile.dataDir, 'relocations')
    await mkdir(directory, { recursive: true })
    // Retain original paths/recovery evidence; never reuse a mutable profile as
    // a retry source. Mode 0600 matches the sensitivity of the profile data.
    await writeFileAtomic(
      path.join(directory, `${relocationId}.json`),
      JSON.stringify(snapshot),
      { mode: 0o600 }
    )
  }
  const attemptedRoots = [...new Set([...state.roots, profile.root])]
  await writeFileAtomic(
    statePath,
    JSON.stringify({
      version: 1,
      roots: attemptedRoots,
      relocationId,
      engineResetPending: true,
    }),
    { mode: 0o600 }
  )
  if (snapshot) {
    const current = await readSettings(settingsPath)
    const allowed = [
      snapshot.settings,
      ...attemptedRoots.map((root) =>
        mappedSettings(snapshot.settings, snapshot.sourceRoot, root)
      ),
    ]
    if (!allowed.some((value) => isDeepStrictEqual(value, current)))
      throw new PortableProfileError(
        'Portable settings were edited during relocation'
      )
    const settings = mappedSettings(
      snapshot.settings,
      snapshot.sourceRoot,
      profile.root
    )
    if (settings)
      await writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2), {
        mode: 0o600,
      })
    relocatePortableDatabase(
      database,
      snapshot.database,
      snapshot.sourceRoot,
      profile.root,
      attemptedRoots
    )
  }
  const blocked = await blockUnavailablePortableTasks(
    profile,
    database,
    moved,
    snapshot?.database,
    snapshot?.sourceRoot
  )
  if (moved || blocked || state.engineResetPending) {
    const engineDir = portableEngineStateDirectory(profile)
    try {
      await rename(engineDir, `${engineDir}.previous-${randomUUID()}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  await mkdir(portableEngineStateDirectory(profile), { recursive: true })
  await writeFileAtomic(
    statePath,
    JSON.stringify({
      version: 1,
      roots: [profile.root],
      engineResetPending: false,
    }),
    { mode: 0o600 }
  )
  return moved
}

async function blockUnavailablePortableTasks(
  profile: PortableProfile,
  db: Database.Database,
  moved: boolean,
  original?: PortableDatabaseSnapshot,
  sourceRoot = profile.root
): Promise<boolean> {
  const current = capturePortableDatabase(db, ['tasks', 'task_instances'])
  const source = original ?? current
  const originalTasks = new Map(
    (source.tasks ?? []).map((row) => [row.motrix_id, row])
  )
  const groupInstances = (snapshot: PortableDatabaseSnapshot) => {
    const groups = new Map<
      string,
      NonNullable<PortableDatabaseSnapshot['task_instances']>
    >()
    for (const instance of snapshot.task_instances ?? []) {
      const id = String(instance.motrix_id)
      const group = groups.get(id) ?? []
      group.push(instance)
      groups.set(id, group)
    }
    return groups
  }
  const currentInstances = groupInstances(current)
  const sourceInstances = original ? groupInstances(source) : currentInstances
  const blocked: string[] = []
  const directoryChecks = new Map<string, Promise<boolean>>()
  for (const row of current.tasks ?? []) {
    const id = String(row.motrix_id)
    const instances = currentInstances.get(id) ?? []
    const pendingTransition = instances.some(
      (instance) =>
        instance.transition_phase && instance.transition_phase !== 'idle'
    )
    const pendingBtFinalize = instances.some((instance) => {
      const payload =
        typeof instance.payload === 'string' ? JSON.parse(instance.payload) : {}
      return (
        payload.btStorageLayout?.version === 2 &&
        payload.btStorageLayout.finalized === false
      )
    })
    if (
      row.agg_status === 'removed' ||
      (['completed', 'error'].includes(String(row.agg_status)) &&
        !pendingTransition &&
        !pendingBtFinalize)
    )
      continue
    const originalRow = originalTasks.get(row.motrix_id) ?? row
    const originalInstances = sourceInstances.get(id) ?? []
    const paths = [
      originalRow.save_dir,
      originalRow.final_path,
      originalRow.torrent_meta_path,
      ...originalInstances.flatMap((instance) => [
        instance.disk_path,
        ...portablePayloadPaths(
          typeof instance.payload === 'string'
            ? JSON.parse(instance.payload)
            : {}
        ),
      ]),
    ].filter(
      (value): value is string =>
        typeof value === 'string' && path.win32.isAbsolute(value)
    )
    const external = paths.filter(
      (value) => !isWithinPortableRoot(value, sourceRoot)
    )
    let unavailable = moved && external.length > 0
    for (const value of unavailable ? [] : external) {
      const directory =
        value === originalRow.save_dir ? value : path.win32.dirname(value)
      let check = directoryChecks.get(directory)
      if (!check) {
        check = stat(directory).then(
          (info) => info.isDirectory(),
          () => false
        )
        directoryChecks.set(directory, check)
      }
      if (!(await check)) {
        unavailable = true
        break
      }
    }
    if (unavailable) blocked.push(id)
  }
  db.transaction(() => {
    for (const id of blocked) {
      db.prepare(
        "UPDATE tasks SET agg_status = 'error', error_code = 'DL_FILE_WRITE_ERROR', error_detail_key = 'task.recovery.startup.portableExternalPath', error_message = NULL, error_detail_params = NULL WHERE motrix_id = ?"
      ).run(id)
      // Keep the transition and payload intact for explicit recovery. The
      // startup recovery gate prevents automatic filesystem work on this task.
      db.prepare(
        "UPDATE task_instances SET status = 'error' WHERE motrix_id = ?"
      ).run(id)
    }
    const hasJournals = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'plugin_finalize_journals'"
      )
      .get()
    if (hasJournals) {
      const quarantine = db.prepare(
        "UPDATE plugin_finalize_journals SET phase = 'quarantined', quarantine_reason = 'portable-profile-relocated' WHERE phase NOT IN ('cleaned', 'quarantined') AND (? OR task_id = ?)"
      )
      if (moved) quarantine.run(1, '')
      else for (const id of blocked) quarantine.run(0, id)
    }
  })()
  return blocked.length > 0
}
