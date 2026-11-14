import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import type { TorrentMetaStore } from '@core/task/torrent-meta-store'
import { AppError, ErrorCode } from '@shared/errors'
import {
  type TorrentManifest,
  type TorrentManifestRecord,
  torrentManifestRecordSchema,
  torrentManifestReferenceSchema,
} from '@shared/schemas/torrent-manifest'
import type { DownloadTask } from '@shared/types/task'
import writeFileAtomic from 'write-file-atomic'

export function manifestRecord(
  manifest: TorrentManifest,
  metadata: Uint8Array
): TorrentManifestRecord {
  return {
    manifest,
    metadataSha256: createHash('sha256').update(metadata).digest('hex'),
  }
}

export async function persistTorrentManifest(
  metaPath: string,
  record: TorrentManifestRecord
) {
  await writeFileAtomic(`${metaPath}.manifest.json`, JSON.stringify(record))
  // Task snapshots carry only a bounded reference, never the entire file tree.
  return { version: 1 as const, metadataSha256: record.metadataSha256 }
}

function reference(task: DownloadTask) {
  const instances = task.instances ?? []
  const instance =
    instances.find((item) => item.gid === task.engineTaskId) ?? instances[0]
  const raw = instance?.payload.verifiedTorrentManifest
  if (raw === undefined) return undefined
  return torrentManifestReferenceSchema.parse(raw)
}

export async function verifiedTorrentRecord(
  task: DownloadTask,
  metadata: Uint8Array
): Promise<TorrentManifestRecord | undefined> {
  const marker = reference(task)
  if (!marker) return undefined
  if (
    !task.torrentMetaPath ||
    marker.metadataSha256 !==
      createHash('sha256').update(metadata).digest('hex')
  )
    throw new AppError(
      ErrorCode.TorrentParseFailed,
      'Saved torrent manifest does not match its metadata'
    )
  try {
    const record = torrentManifestRecordSchema.parse(
      JSON.parse(
        await readFile(`${task.torrentMetaPath}.manifest.json`, 'utf8')
      )
    )
    if (record.metadataSha256 !== marker.metadataSha256)
      throw new Error('Manifest digest mismatch')
    return record
  } catch (error) {
    throw new AppError(
      ErrorCode.TorrentParseFailed,
      'Saved torrent manifest is unavailable or invalid',
      error
    )
  }
}

/** Capture complete proofs before retiring the engine task; preserve the old snapshot on a crash. */
export async function refreshTorrentArtifact(
  task: DownloadTask,
  metadata: Uint8Array,
  adapter: Partial<Pick<EngineAdapter, 'getTorrentMetadata'>>,
  store: Partial<Pick<TorrentMetaStore, 'persist'>>
): Promise<Uint8Array> {
  const previous = await verifiedTorrentRecord(task, metadata)
  if (
    !previous ||
    previous.manifest.verificationReady ||
    !task.engineTaskId ||
    !adapter.getTorrentMetadata ||
    !store.persist
  )
    return metadata
  let response: Awaited<ReturnType<EngineAdapter['getTorrentMetadata']>>
  try {
    response = await adapter.getTorrentMetadata(task.engineTaskId)
  } catch (error) {
    if (
      error instanceof AppError &&
      error.code === ErrorCode.EngineProtocolError
    )
      throw error
    return metadata
  }
  // At most one immutable upgrade per task. Partial proofs stay in the engine;
  // repeatedly snapshotting them would multiply large sidecars on every retry.
  if (!response.manifest?.verificationReady) return metadata
  if (
    response.manifest.infoHash !== previous.manifest.infoHash ||
    response.manifest.v1 !== previous.manifest.v1 ||
    response.manifest.v2 !== previous.manifest.v2 ||
    response.manifest.name !== previous.manifest.name ||
    response.manifest.multiFile !== previous.manifest.multiFile ||
    response.manifest.isPrivate !== previous.manifest.isPrivate ||
    JSON.stringify(response.manifest.files) !==
      JSON.stringify(previous.manifest.files)
  )
    throw new AppError(
      ErrorCode.TorrentParseFailed,
      'Engine returned a different torrent identity or layout'
    )
  const bytes = Buffer.from(response.data, 'base64')
  const record = manifestRecord(response.manifest, bytes)
  if (record.metadataSha256 === previous.metadataSha256) return metadata
  const previousPath = task.torrentMetaPath ?? undefined
  const metaPath = await store.persist(
    `${task.id}-${record.metadataSha256.slice(0, 16)}`,
    bytes
  )
  const marker = await persistTorrentManifest(metaPath, record)
  for (const instance of task.instances)
    if (instance.payload.verifiedTorrentManifest !== undefined)
      instance.payload = {
        ...instance.payload,
        verifiedTorrentManifest: { ...marker, previousPath },
      }
  task.torrentMetaPath = metaPath
  return bytes
}

export async function removeTorrentArtifact(
  task: DownloadTask,
  store: TorrentMetaStore
): Promise<void> {
  if (!task.torrentMetaPath) return
  let marker: ReturnType<typeof reference>
  try {
    marker = reference(task)
  } catch {
    /* A corrupt reference must not prevent removal of the owned current sidecar. */
  }
  const previous = marker?.previousPath
  await store.remove(task.torrentMetaPath)
  if (
    marker &&
    previous &&
    path.dirname(previous) === path.dirname(task.torrentMetaPath) &&
    path.basename(previous) === `${task.id}.torrent` &&
    path.basename(task.torrentMetaPath) ===
      `${task.id}-${marker.metadataSha256.slice(0, 16)}.torrent`
  )
    await store.remove(previous)
}
