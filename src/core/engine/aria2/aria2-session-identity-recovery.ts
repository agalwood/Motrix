import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parseEngineTorrent as parseTorrent } from '@shared/lib/engine-torrent'
import { MAX_TORRENT_BASE64_SIZE } from '@shared/lib/torrent-meta'
import Database from 'better-sqlite3'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import type {
  EngineSessionRecoveryStore,
  EngineSessionTaskFailure,
} from '../engine-session-recovery'

const gidSchema = z.string().regex(/^[0-9a-f]{16}$/)
const rowSchema = z.object({
  gid: gidSchema,
  state: z.string(),
  serialized: z.string(),
})
type Row = z.infer<typeof rowSchema>

interface Entry {
  source: string
  gid: string
  directory: string
  options: string[]
  paused: boolean
}

/** Parse only the single-entry format emitted by aria2's session writer. */
function parseEntry(text: string): Entry | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  const source = lines.shift()
  if (!source?.startsWith('magnet:') || /\t/.test(source)) return null
  const options = new Map<string, string>()
  for (const line of lines) {
    const match = /^[ \t]+([^=\s]+)=(.*)$/.exec(line)
    if (!match) return null
    const [, key, value] = match
    if (['gid', 'dir', 'pause'].includes(key) && options.has(key)) return null
    options.set(key, value)
  }
  const gid = gidSchema.safeParse(options.get('gid'))
  const directory = options.get('dir')
  if (!gid.success || !directory || !path.isAbsolute(directory)) return null
  return {
    source,
    gid: gid.data,
    directory,
    options: lines,
    paused: options.get('pause') === 'true',
  }
}

function failure(gid: string, reason: string): Error {
  // Do not include serialized options, which may contain cookies or tokens.
  return new Error(`aria2 session recovery for GID ${gid}: ${reason}`)
}

export interface SessionIdentityRecovery {
  backupPath: string
  repairedGids: string[]
  retiredMetadataGids: string[]
  quarantinedGids: string[]
}

async function readMatchingMetadata(
  metadataPath: string,
  infoHash: string
): Promise<Buffer | null> {
  let bytes: Buffer
  try {
    const metadataStat = await stat(metadataPath)
    if (
      !metadataStat.isFile() ||
      metadataStat.size > (MAX_TORRENT_BASE64_SIZE * 3) / 4
    )
      return null
    bytes = await readFile(metadataPath)
  } catch (error) {
    if (
      ['ENOENT', 'ENOTDIR'].includes(
        (error as NodeJS.ErrnoException).code ?? ''
      )
    )
      return null
    // Permission and storage failures are not evidence that a task was deleted.
    throw error
  }
  try {
    const torrent = await parseTorrent(bytes)
    return torrent.infoHash === infoHash && torrent.files?.length ? bytes : null
  } catch {
    return null
  }
}

/**
 * Repair the fork's metadata-ancestor GID serialization (schema v1–v6) before spawn.
 * The actual row key remains the owner of progress, cookies and app identity.
 * A verified local torrent replaces the magnet so aria2 recreates that exact
 * payload task directly. Unrecoverable tasks are backed up and retained in the
 * application before their engine rows are retired. Download data is untouched.
 */
export async function recoverAria2SessionIdentity(
  databasePath: string,
  canRepair: () => boolean = () => true,
  recoveryStore?: EngineSessionRecoveryStore
): Promise<SessionIdentityRecovery | null> {
  try {
    await stat(databasePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const db = new Database(databasePath, { fileMustExist: true, timeout: 0 })
  try {
    const schemaVersion = db.pragma('user_version', { simple: true })
    if (![1, 2, 3, 4, 5, 6].includes(Number(schemaVersion))) return null
    const dataVersion = db.pragma('data_version', { simple: true })
    const rows = z
      .array(rowSchema)
      .parse(db.prepare('SELECT gid, state, serialized FROM task').all())
    const candidates = rows.flatMap((row) => {
      const entry = parseEntry(row.serialized)
      return entry && row.gid !== entry.gid ? [{ row, entry }] : []
    })
    if (candidates.length === 0) return null
    const legacyGids = new Set(
      Number(schemaVersion) >= 4
        ? (
            db
              .prepare(
                Number(schemaVersion) >= 5
                  ? 'SELECT gid FROM legacy_checkpoint_import UNION SELECT gid FROM legacy_torrent_metadata'
                  : 'SELECT gid FROM legacy_checkpoint_import'
              )
              .all() as Array<{ gid: string }>
          ).map((row) => row.gid)
        : []
    )
    for (const { row, entry } of candidates) {
      if (legacyGids.has(row.gid) || legacyGids.has(entry.gid))
        throw failure(row.gid, 'legacy checkpoint identity is immutable')
    }
    if (!canRepair())
      throw new Error('aria2 session recovery requires a stopped engine')

    const retiredMetadataGids = new Set<string>()
    const retiredHistoryIds = new Set<number>()
    const plans: Array<{ row: Row; entry: Entry; bytes: Buffer }> = []
    const quarantined: EngineSessionTaskFailure[] = []
    for (const { row, entry } of candidates) {
      if (!['waiting', 'paused'].includes(row.state))
        throw failure(row.gid, 'unsupported task state')
      const parent = rows.find((candidate) => candidate.gid === entry.gid)
      const history = db
        .prepare(
          'SELECT id, status, followed_by FROM download_history WHERE gid = ? ORDER BY id DESC'
        )
        .all(entry.gid) as Array<{
        id: number
        status: string
        followed_by: string | null
      }>
      const confirmsChild = (record: (typeof history)[number]): boolean => {
        if (record.status !== 'complete') return false
        try {
          return z
            .array(gidSchema)
            .parse(JSON.parse(record.followed_by ?? 'null'))
            .includes(row.gid)
        } catch {
          return false
        }
      }
      const verifiedAncestor = history[0] && confirmsChild(history[0])
      if (parent) {
        const parentEntry = parseEntry(parent.serialized)
        if (
          parentEntry?.source !== entry.source ||
          parentEntry.gid !== parent.gid ||
          !verifiedAncestor
        )
          throw failure(row.gid, 'metadata ancestry could not be verified')
      }
      if (verifiedAncestor) {
        retiredMetadataGids.add(entry.gid)
        // Stopped history can otherwise be adopted as a separate download even
        // after its task row is gone. Retire only individually proven ancestors;
        // a reused GID does not authorize deleting unrelated history.
        for (const record of history)
          if (confirmsChild(record)) retiredHistoryIds.add(record.id)
      }

      let infoHash: string
      try {
        const magnet = await parseTorrent(entry.source)
        if (!magnet.infoHash || !/^[a-f0-9]{40}$/.test(magnet.infoHash))
          throw new Error('invalid infohash')
        infoHash = magnet.infoHash
      } catch {
        throw failure(row.gid, 'invalid magnet identity')
      }
      const task = {
        engineTaskId: row.gid,
        metadataTaskId: entry.gid,
        sourceUri: entry.source,
        saveDir: entry.directory,
        infoHash,
      }
      const context = recoveryStore?.getContext(task)
      let directoryMissing = false
      if (!context?.retired) {
        try {
          directoryMissing = !(await stat(entry.directory)).isDirectory()
        } catch (error) {
          if (
            !['ENOENT', 'ENOTDIR'].includes(
              (error as NodeJS.ErrnoException).code ?? ''
            )
          )
            throw error
          directoryMissing = true
        }
      }
      let bytes: Buffer | null = null
      if (!context?.retired && !directoryMissing) {
        const metadataPaths = new Set([
          path.join(entry.directory, `${infoHash}.torrent`),
          ...(context?.metadataPaths ?? []),
        ])
        for (const metadataPath of metadataPaths) {
          bytes = await readMatchingMetadata(metadataPath, infoHash)
          if (bytes) break
        }
      }
      if (bytes) {
        plans.push({ row, entry, bytes })
      } else if (recoveryStore) {
        quarantined.push({
          ...task,
          reason: directoryMissing ? 'files-missing' : 'metadata-unavailable',
        })
      } else {
        // Standalone callers cannot discard a task without a durable UI owner.
        throw failure(
          row.gid,
          'matching saved torrent metadata is unavailable; session was not changed'
        )
      }
    }

    if (!canRepair())
      throw new Error('aria2 session recovery requires a stopped engine')
    const recoveryDir = await mkdtemp(
      `${path.resolve(databasePath)}.identity-recovery-`
    )
    const backupPath = path.join(recoveryDir, 'aria2.db')
    // SQLite's backup API includes committed WAL pages; a raw file copy does not.
    await db.backup(backupPath)
    await chmod(backupPath, 0o600)
    const changes: Array<{
      row: Row
      serialized: string
      metadataPath: string
    }> = []
    for (const { row, entry, bytes } of plans) {
      const metadataPath = path.join(recoveryDir, `${row.gid}.torrent`)
      if (/[\r\n\t]/.test(metadataPath))
        throw failure(
          row.gid,
          'metadata path cannot be represented in an aria2 session'
        )
      // Keep recovery independent of cleanup of the original metadata file.
      await writeFileAtomic(metadataPath, bytes, { mode: 0o600 })
      const options = entry.options.filter(
        (line) => !/^[ \t]+(?:gid|pause|torrent-file)=/.test(line)
      )
      const serialized = `${metadataPath}\n gid=${row.gid}\n${row.state === 'paused' || entry.paused ? ' pause=true\n' : ''}${options.join('\n')}\n`
      changes.push({ row, serialized, metadataPath })
    }

    // Commit application errors first. A crash or engine transaction failure
    // leaves those identities retired in getContext(), so a subsequent boot
    // cannot revive them even if their metadata has since reappeared.
    if (quarantined.length && recoveryStore)
      await recoveryStore.quarantine(quarantined)

    db.pragma('foreign_keys = ON')
    db.transaction(() => {
      if (
        !canRepair() ||
        db.pragma('data_version', { simple: true }) !== dataVersion
      )
        throw new Error(
          'aria2 session changed during recovery; retry with the engine stopped'
        )
      const update = db.prepare(
        'UPDATE task SET serialized = ?, digest = ?, bt_local_path = ?, updated_at = ? WHERE gid = ? AND serialized = ? AND state = ?'
      )
      for (const { row, serialized, metadataPath } of changes) {
        const digest = createHash('sha1')
          .update(serialized)
          .update(row.state)
          .digest()
        const result = update.run(
          serialized,
          digest,
          metadataPath,
          Date.now(),
          row.gid,
          row.serialized,
          row.state
        )
        if (result.changes !== 1)
          throw failure(row.gid, 'task changed during recovery')
      }
      const remove = db.prepare('DELETE FROM task WHERE gid = ?')
      // Schema v3 and later do not cascade task → task_progress (checkpoints are
      // addressed by output path), so a retired ancestor's checkpoint is
      // dropped explicitly, exactly as v1/v2 did through the cascade.
      const removeProgress =
        Number(schemaVersion) >= 3
          ? db.prepare('DELETE FROM task_progress WHERE gid = ?')
          : null
      for (const gid of new Set([
        ...retiredMetadataGids,
        ...quarantined.map((task) => task.engineTaskId),
      ])) {
        remove.run(gid)
        removeProgress?.run(gid)
      }
      const removeHistory = db.prepare(
        'DELETE FROM download_history WHERE id = ?'
      )
      for (const id of retiredHistoryIds) removeHistory.run(id)
    }).immediate()
    return {
      backupPath,
      repairedGids: plans.map(({ row }) => row.gid),
      retiredMetadataGids: [...retiredMetadataGids],
      quarantinedGids: quarantined.map((task) => task.engineTaskId),
    }
  } finally {
    db.close()
  }
}
