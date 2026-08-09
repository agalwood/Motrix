import type {
  TaskFileRow,
  TaskInstanceRow,
  TaskRow,
  TaskWithInstancesAndFiles,
} from '@core/session/motrix-database'
import { TaskInstancePhase } from '@shared/types/task'

export const MAGNET_CLEANUP_QUARANTINED_PAYLOAD_KEY =
  'cleanupQuarantined' as const
export const MAGNET_CLEANUP_TOMBSTONE_HIDDEN_PAYLOAD_KEY =
  'cleanupTombstoneHidden' as const
export const MAGNET_CLEANUP_ARTIFACT_PATHS_PAYLOAD_KEY =
  'cleanupArtifactPaths' as const
export const MAGNET_CLEANUP_RESTORE_GRAPH_PAYLOAD_KEY =
  'cleanupRestoreGraph' as const

interface MagnetMetadataInstanceLike {
  phase: TaskInstancePhase
  payload: Record<string, unknown>
}

/**
 * Cleanup quarantine means aria2 removal could not be confirmed and the GID
 * must remain shielded from generic task adoption. It does not by itself say
 * whether the task should be hidden from history.
 */
export function isMagnetCleanupQuarantined(
  instance: MagnetMetadataInstanceLike | null | undefined
): boolean {
  return (
    instance?.phase === TaskInstancePhase.MagnetMetadataResolution &&
    instance.payload[MAGNET_CLEANUP_QUARANTINED_PAYLOAD_KEY] === true
  )
}

/**
 * Hidden cleanup tombstones carry an independent user-delete intent.
 *
 * Keeping visibility separate from cleanup quarantine is important: a normal
 * metadata failure can also exhaust cleanup retries, but must remain visible
 * as Error history after restart.
 */
export function isMagnetCleanupTombstoneHidden(
  instance: MagnetMetadataInstanceLike | null | undefined
): boolean {
  return (
    instance?.phase === TaskInstancePhase.MagnetMetadataResolution &&
    instance.payload[MAGNET_CLEANUP_TOMBSTONE_HIDDEN_PAYLOAD_KEY] === true
  )
}

export function withMagnetCleanupQuarantined(
  payload: Record<string, unknown>,
  quarantined: boolean
): Record<string, unknown> {
  return {
    ...payload,
    [MAGNET_CLEANUP_QUARANTINED_PAYLOAD_KEY]: quarantined,
  }
}

export function withMagnetCleanupTombstoneHidden(
  payload: Record<string, unknown>,
  hidden: boolean
): Record<string, unknown> {
  return {
    ...payload,
    [MAGNET_CLEANUP_TOMBSTONE_HIDDEN_PAYLOAD_KEY]: hidden,
  }
}

export function withMagnetCleanupArtifactPaths(
  payload: Record<string, unknown>,
  artifactPaths: readonly string[]
): Record<string, unknown> {
  return {
    ...payload,
    [MAGNET_CLEANUP_ARTIFACT_PATHS_PAYLOAD_KEY]: [...artifactPaths],
  }
}

export function getMagnetCleanupArtifactPaths(
  instance: MagnetMetadataInstanceLike | null | undefined
): string[] {
  if (instance?.phase !== TaskInstancePhase.MagnetMetadataResolution) {
    return []
  }
  const value = instance.payload[MAGNET_CLEANUP_ARTIFACT_PATHS_PAYLOAD_KEY]
  if (!Array.isArray(value)) return []
  return value.filter((path): path is string => typeof path === 'string')
}

/**
 * A failed metadata -> BT swap reserves its caller-selected aria2 GID before
 * creating engine work. The reservation temporarily replaces the metadata
 * instance, so it must carry the exact graph that cleanup restores after a
 * crash. Keeping the graph in the already-durable SQLite row avoids relying
 * on a second, best-effort tombstone write after the graph commit fails.
 */
export function withMagnetCleanupRestoreGraph(
  payload: Record<string, unknown>,
  graph: TaskWithInstancesAndFiles
): Record<string, unknown> {
  return {
    ...payload,
    [MAGNET_CLEANUP_RESTORE_GRAPH_PAYLOAD_KEY]: graph,
  }
}

export function getMagnetCleanupRestoreGraph(
  instance: MagnetMetadataInstanceLike | null | undefined,
  taskId: string
): TaskWithInstancesAndFiles | null {
  if (instance?.phase !== TaskInstancePhase.MagnetMetadataResolution) {
    return null
  }
  const value = instance.payload[MAGNET_CLEANUP_RESTORE_GRAPH_PAYLOAD_KEY]
  return isTaskGraph(value, taskId) ? value : null
}

function isTaskGraph(
  value: unknown,
  taskId: string
): value is TaskWithInstancesAndFiles {
  if (!isRecord(value)) return false
  if (!isTaskRow(value.task, taskId)) return false
  if (
    !Array.isArray(value.instances) ||
    !value.instances.every((instance) => isTaskInstanceRow(instance, taskId))
  ) {
    return false
  }
  return (
    Array.isArray(value.files) &&
    value.files.every((file) => isTaskFileRow(file))
  )
}

function isTaskRow(value: unknown, taskId: string): value is TaskRow {
  if (!isRecord(value) || value.motrixId !== taskId) return false

  const stringKeys = [
    'name',
    'kind',
    'taskType',
    'finalPath',
    'finalName',
    'aggStatus',
    'source',
  ] as const
  const numberKeys = [
    'priority',
    'createdAt',
    'updatedAt',
    'totalBytes',
    'downloadedBytes',
    'sizeWhenDone',
    'fileCount',
    'pieceLength',
    'uploadedBytesBaseline',
  ] as const
  if (!stringKeys.every((key) => typeof value[key] === 'string')) return false
  if (!numberKeys.every((key) => typeof value[key] === 'number')) return false
  if (typeof value.isPrivate !== 'boolean') return false
  if (!isNullableString(value.category) || !isNullableString(value.tags)) {
    return false
  }
  if (
    !isNullableString(value.torrentMetaPath) ||
    !isNullableString(value.infoHash) ||
    !isNullableString(value.errorMessage) ||
    !isNullableString(value.errorCode)
  ) {
    return false
  }
  if (value.finishedAt !== null && typeof value.finishedAt !== 'number') {
    return false
  }
  if (
    !Array.isArray(value.trackers) ||
    !value.trackers.every(
      (tier) =>
        Array.isArray(tier) &&
        tier.every((tracker) => typeof tracker === 'string')
    )
  ) {
    return false
  }
  return value.sourceMeta === null || isRecord(value.sourceMeta)
}

function isTaskInstanceRow(
  value: unknown,
  taskId: string
): value is TaskInstanceRow {
  if (
    !isRecord(value) ||
    value.motrixId !== taskId ||
    typeof value.instanceId !== 'string'
  ) {
    return false
  }
  if (value.gid !== null && typeof value.gid !== 'string') return false
  const stringKeys = ['phase', 'status', 'diskPath', 'transitionPhase'] as const
  const numberKeys = [
    'progress',
    'totalBytes',
    'downloadedBytes',
    'uploadedBytes',
    'createdAt',
    'updatedAt',
  ] as const
  if (!stringKeys.every((key) => typeof value[key] === 'string')) return false
  if (!numberKeys.every((key) => typeof value[key] === 'number')) return false
  if (
    !Array.isArray(value.uris) ||
    !value.uris.every((uri) => typeof uri === 'string')
  ) {
    return false
  }
  return isNullableString(value.uriHash) && isRecord(value.payload)
}

function isTaskFileRow(value: unknown): value is TaskFileRow {
  return (
    isRecord(value) &&
    typeof value.fileIndex === 'number' &&
    typeof value.path === 'string' &&
    typeof value.size === 'number' &&
    typeof value.selected === 'boolean'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}
