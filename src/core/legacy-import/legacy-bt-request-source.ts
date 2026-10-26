import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { LegacyProxyOptions } from '@core/engine/engine-adapter'
import type { MotrixDatabase } from '@core/session/motrix-database'
import { parseBtFileLayout } from '@core/task/bt-storage-layout'
import { AppError, ErrorCode } from '@shared/errors'
import {
  type LegacyBtRequestSource,
  legacyBtRequestSourceSchema,
} from '@shared/schemas/legacy-bt-request'
import { legacyTaskMetadataSchema } from '@shared/schemas/legacy-import'
import { TaskType } from '@shared/types/task'
import parseTorrent from 'parse-torrent'
import { z } from 'zod'
import { parseLegacySystem, resolveLegacyProxyOptions } from './proxy-context'
import {
  digestBytes,
  parseLegacySession,
  resolveLegacyRequestSettings,
  safeLegacyOutput,
} from './session-parser'
import { authorizeLegacySource, readLegacyFile } from './source-scanner'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const manifestSchema = z
  .object({
    version: z.literal(1),
    sourceId: digest,
    snapshotDigest: digest,
    files: z
      .array(z.object({ relativePath: z.string(), digest }).strict())
      .min(3)
      .max(10004),
  })
  .strict()
const failure = (key = 'changedSource') =>
  new AppError(ErrorCode.InvalidSelection, `legacyImport.errors.${key}`)
interface SourceRow {
  runId: string
  sourceId: string
  snapshotDigest: string
  backupPath: string | null
  itemKey: string
  taskId: string
  entryDigest: string
}

/** Replays only a private, imported backup; original tasks and v1 paths may be gone. */
export class LegacyBtRequestSourceService {
  constructor(
    private readonly deps: { db: MotrixDatabase; backupRoot: string }
  ) {}

  async capture(
    sourceTaskId: string,
    expected: { uri?: string; metadata?: Uint8Array; infoHash?: string }
  ): Promise<LegacyBtRequestSource> {
    try {
      const pair = this.deps.db.getTask(sourceTaskId)
      const marker = legacyTaskMetadataSchema.safeParse(
        pair?.instances[0]?.payload.legacyImport
      )
      if (
        !pair ||
        !marker.success ||
        marker.data.activation !== 'inactive' ||
        marker.data.storagePolicy !== 'legacy-read-only' ||
        !marker.data.origin ||
        pair.instances.length !== 1 ||
        pair.instances[0].gid ||
        ![TaskType.Bt, TaskType.Magnet].includes(pair.task.taskType)
      )
        throw failure('activationSourceMissing')
      const rows = this.rows('i.task_id = ?', sourceTaskId)
      if (rows.length !== 1) throw failure('activationSourceMissing')
      const row = rows[0]
      if (
        row.sourceId !== marker.data.sourceId ||
        row.itemKey !== marker.data.itemKey
      )
        throw failure()
      const backup = await this.backup(row)
      const profile = marker.data.origin.profileFiles
      if (
        profile.length !== 3 ||
        new Set(profile.map((file) => file.relativePath)).size !== 3 ||
        profile.some(
          (file) =>
            !['download.session', 'system.json', 'user.json'].includes(
              file.relativePath
            ) ||
            backup.manifest.files.find(
              (entry) => entry.relativePath === file.relativePath
            )?.digest !== file.digest
        ) ||
        profile.find((file) => file.relativePath === 'download.session')
          ?.digest !== marker.data.origin.sessionDigest
      )
        throw failure()
      const reference = legacyBtRequestSourceSchema.parse({
        version: 1,
        runId: row.runId,
        itemKey: row.itemKey,
        snapshotDigest: row.snapshotDigest,
        manifestDigest: backup.manifestDigest,
        infoHash:
          pair.task.taskType === TaskType.Bt
            ? pair.task.infoHash
            : (await parseTorrent(pair.instances[0].uris[0] ?? '')).infoHash,
        torrentDigest: marker.data.origin.torrentDigest,
      })
      const context = await this.context(row, reference, backup)
      if (context.targetPath !== pair.task.finalPath) throw failure()
      if (pair.task.taskType === TaskType.Magnet) {
        if (
          context.kind !== 'magnet' ||
          expected.uri !== context.uri ||
          pair.instances[0].uris.length !== 1 ||
          pair.instances[0].uris[0] !== context.uri ||
          expected.metadata !== undefined
        )
          throw failure()
      } else if (
        context.kind !== 'bt' ||
        !expected.metadata ||
        digestBytes(expected.metadata) !== reference.torrentDigest ||
        expected.uri !== undefined
      )
        throw failure()
      if (
        (expected.infoHash &&
          expected.infoHash.toLowerCase() !== reference.infoHash) ||
        JSON.stringify(this.deps.db.getTask(sourceTaskId)) !==
          JSON.stringify(pair)
      )
        throw failure()
      return reference
    } catch (error) {
      if (error instanceof AppError) throw error
      throw failure()
    }
  }

  async resolve(
    source: LegacyBtRequestSource,
    expectedInfoHash?: string
  ): Promise<LegacyProxyOptions> {
    try {
      const reference = legacyBtRequestSourceSchema.parse(source)
      if (
        expectedInfoHash &&
        expectedInfoHash.toLowerCase() !== reference.infoHash
      )
        throw failure()
      const rows = this.rows(
        'i.run_id = ? AND i.item_key = ?',
        reference.runId,
        reference.itemKey
      )
      if (rows.length !== 1) throw failure('activationSourceMissing')
      const row = rows[0]
      if (row.snapshotDigest !== reference.snapshotDigest) throw failure()
      const backup = await this.backup(row)
      if (backup.manifestDigest !== reference.manifestDigest) throw failure()
      return (await this.context(row, reference, backup)).proxy
    } catch (error) {
      if (error instanceof AppError) throw error
      throw failure()
    }
  }

  private rows(where: string, ...parameters: string[]): SourceRow[] {
    return this.deps.db.database
      .prepare(
        `SELECT r.run_id AS runId, r.source_id AS sourceId,
          r.snapshot_digest AS snapshotDigest, r.backup_path AS backupPath,
          i.item_key AS itemKey, i.task_id AS taskId, l.entry_digest AS entryDigest
         FROM legacy_import_items i
         JOIN legacy_import_runs r ON r.run_id = i.run_id
         JOIN legacy_import_ledger l ON l.source_id = r.source_id
           AND l.item_key = i.item_key AND l.task_id = i.task_id
         WHERE i.outcome = 'imported' AND (${where})`
      )
      .all(...parameters) as SourceRow[]
  }

  private async backup(row: SourceRow) {
    const root = path.resolve(this.deps.backupRoot)
    if (
      (await lstat(root)).isSymbolicLink() ||
      (await realpath(root)) !== root ||
      row.backupPath !== path.join(root, row.runId)
    )
      throw failure('unsafeBackup')
    const source = await authorizeLegacySource(root)
    const file = await readLegacyFile(source, `${row.runId}/manifest.json`)
    if (!file) throw failure('activationSourceMissing')
    const manifest = manifestSchema.parse(
      JSON.parse(file.bytes.toString('utf8'))
    )
    if (
      manifest.sourceId !== row.sourceId ||
      manifest.snapshotDigest !== row.snapshotDigest ||
      new Set(manifest.files.map((entry) => entry.relativePath)).size !==
        manifest.files.length
    )
      throw failure()
    const read = async (relativePath: string) => {
      const expected = manifest.files.find(
        (entry) => entry.relativePath === relativePath
      )
      if (!expected) throw failure()
      const result = await readLegacyFile(
        source,
        `${row.runId}/${relativePath}`
      )
      if (!result || result.digest !== expected.digest) throw failure()
      return result.bytes
    }
    return { manifest, manifestDigest: file.digest, read }
  }

  private async context(
    row: SourceRow,
    reference: LegacyBtRequestSource,
    backup: Awaited<ReturnType<LegacyBtRequestSourceService['backup']>>
  ) {
    const session = await backup.read('download.session')
    const system = parseLegacySystem(await backup.read('system.json'))
    // All profile hashes belong to the captured immutable backup, including
    // the unused preferences file; a damaged backup never falls back globally.
    await backup.read('user.json')
    const matches = parseLegacySession(session).filter(
      (entry) => entry.digest === row.entryDigest
    )
    if (matches.length !== 1) throw failure()
    const entry = matches[0]
    if (entry.reason === 'invalid-record' || entry.uris.length !== 1)
      throw failure()
    const uri = entry.uris[0]
    const kind = uri.startsWith('magnet:?') ? 'magnet' : 'bt'
    let infoHash: string | undefined
    let filename: string | undefined
    if (kind === 'magnet') {
      if (reference.torrentDigest !== null) throw failure()
      const parsed = await parseTorrent(uri)
      infoHash = parsed.infoHash
      filename = new URL(uri).searchParams.get('dn') || 'Magnet'
    } else {
      const file = backup.manifest.files.find(
        (entry) => entry.digest === reference.torrentDigest
      )
      if (!file) throw failure()
      const metadata = await backup.read(file.relativePath)
      const layout = await parseBtFileLayout(metadata)
      infoHash = layout.infoHash
      filename = layout.torrentRootName
    }
    if (infoHash !== reference.infoHash) throw failure()
    const directory = entry.options.dir ?? system.dir
    const targetPath =
      typeof directory === 'string'
        ? safeLegacyOutput(directory, entry.options.out || filename)
        : null
    if (!targetPath) throw failure()
    const key = entry.gid
      ? entry.itemKey
      : `entry:${digestBytes(
          JSON.stringify([
            kind,
            targetPath,
            kind === 'magnet'
              ? new URL(uri).searchParams
                  .getAll('xt')
                  .map((value) => value.toLowerCase())
                  .sort()
              : infoHash,
          ])
        )}`
    if (key !== row.itemKey) throw failure()
    return {
      kind,
      uri,
      targetPath,
      proxy: resolveLegacyProxyOptions(
        resolveLegacyRequestSettings(entry, system, kind).values
      ),
    }
  }
}
