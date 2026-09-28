import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { MAX_TORRENT_BASE64_SIZE } from '@shared/lib/torrent-meta'
import Database from 'better-sqlite3'
import parseTorrent from 'parse-torrent'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'

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
}

/**
 * Repair the fork's metadata-ancestor GID serialization (schema v1–v3) before spawn.
 * The actual row key remains the owner of progress, cookies and app identity.
 * A verified local torrent replaces the magnet so aria2 recreates that exact
 * payload task directly. No engine schema, setting or download data changes.
 */
export async function recoverAria2SessionIdentity(
  databasePath: string,
  canRepair: () => boolean = () => true
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
    if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3)
      return null
    const dataVersion = db.pragma('data_version', { simple: true })
    const rows = z
      .array(rowSchema)
      .parse(db.prepare('SELECT gid, state, serialized FROM task').all())
    const candidates = rows.flatMap((row) => {
      const entry = parseEntry(row.serialized)
      return entry && row.gid !== entry.gid ? [{ row, entry }] : []
    })
    if (candidates.length === 0) return null
    if (!canRepair())
      throw new Error('aria2 session recovery requires a stopped engine')

    const retiredMetadataGids = new Set<string>()
    const plans: Array<{ row: Row; entry: Entry; bytes: Buffer }> = []
    for (const { row, entry } of candidates) {
      if (!['waiting', 'paused'].includes(row.state))
        throw failure(row.gid, 'unsupported task state')
      const parent = rows.find((candidate) => candidate.gid === entry.gid)
      if (parent) {
        const parentEntry = parseEntry(parent.serialized)
        const history = db
          .prepare(
            'SELECT status, followed_by FROM download_history WHERE gid = ? ORDER BY id DESC LIMIT 1'
          )
          .get(parent.gid) as
          | { status: string; followed_by: string | null }
          | undefined
        let children: string[] = []
        try {
          children = z
            .array(gidSchema)
            .parse(JSON.parse(history?.followed_by ?? 'null'))
        } catch {
          // Retire only a proven completed metadata ancestor.
        }
        if (
          parentEntry?.source !== entry.source ||
          parentEntry.gid !== parent.gid ||
          history?.status !== 'complete' ||
          !children.includes(row.gid)
        )
          throw failure(row.gid, 'metadata ancestry could not be verified')
        retiredMetadataGids.add(parent.gid)
      }

      let bytes: Buffer
      try {
        const magnet = await parseTorrent(entry.source)
        if (!magnet.infoHash || !/^[a-f0-9]{40}$/.test(magnet.infoHash))
          throw new Error('invalid infohash')
        const metadataPath = path.join(
          entry.directory,
          `${magnet.infoHash}.torrent`
        )
        const metadataStat = await stat(metadataPath)
        if (
          !metadataStat.isFile() ||
          metadataStat.size > (MAX_TORRENT_BASE64_SIZE * 3) / 4
        )
          throw new Error('invalid metadata size')
        bytes = await readFile(metadataPath)
        const torrent = await parseTorrent(new Uint8Array(bytes))
        if (torrent.infoHash !== magnet.infoHash || !torrent.files?.length)
          throw new Error('metadata does not match magnet')
      } catch {
        throw failure(
          row.gid,
          'matching saved torrent metadata is unavailable; session was not changed'
        )
      }
      plans.push({ row, entry, bytes })
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
      // Schema v3 no longer cascades task → task_progress (checkpoints are
      // addressed by output path), so a retired ancestor's checkpoint is
      // dropped explicitly, exactly as v1/v2 did through the cascade.
      const removeProgress =
        schemaVersion === 3
          ? db.prepare('DELETE FROM task_progress WHERE gid = ?')
          : null
      for (const gid of retiredMetadataGids) {
        remove.run(gid)
        removeProgress?.run(gid)
      }
    }).immediate()
    return {
      backupPath,
      repairedGids: plans.map(({ row }) => row.gid),
      retiredMetadataGids: [...retiredMetadataGids],
    }
  } finally {
    db.close()
  }
}
