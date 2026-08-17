import type { TaskInstanceRow, TaskRow } from '@core/session/motrix-database'
import {
  type DownloadTask,
  makeDefaultBtExtension,
  TaskStatus,
  TransitionPhase,
} from '@shared/types/task'
import { isTorrentLikeType } from '@shared/types/task-actions'

/** Build a generic DownloadTask domain object from canonical TaskRow data.
 *
 * Runtime-only speed, ETA, and connection values start at zero until the next
 * engine snapshot. Durable identity, organization, byte, path, type, and
 * terminal-history fields are restored verbatim.
 */
export function taskRowToDownloadTask(
  task: TaskRow,
  instances: TaskInstanceRow[]
): DownloadTask {
  const primary = instances[0]
  const progress =
    task.aggStatus === TaskStatus.Completed
      ? 1
      : task.totalBytes > 0
        ? task.downloadedBytes / task.totalBytes
        : 0
  const uploadedBytes =
    task.uploadedBytesBaseline + (primary?.uploadedBytes ?? 0)
  const bt = isTorrentLikeType(task.taskType)
    ? makeDefaultBtExtension({
        ratio: task.totalBytes > 0 ? uploadedBytes / task.totalBytes : 0,
        trackers: task.trackers.flat(),
        announceList: task.trackers,
        isPrivate: task.isPrivate,
      })
    : undefined

  return {
    id: task.motrixId,
    engineTaskId: primary?.gid ?? '',
    name: task.name,
    kind: task.kind,
    type: task.taskType,
    status: task.aggStatus,
    progress,
    totalBytes: task.totalBytes,
    downloadedBytes: task.downloadedBytes,
    downloadSpeed: 0,
    uploadSpeed: 0,
    etaSeconds: 0,
    saveDir: primary?.diskPath || task.finalPath,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt,
    errorMessage: task.errorMessage,
    uris: primary?.uris ?? [],
    uploadedBytes,
    uploadedBytesBaseline: task.uploadedBytesBaseline,
    fileCount: task.fileCount,
    connections: 0,
    pieceLength: task.pieceLength,
    infoHash: task.infoHash,
    errorCode: task.errorCode,
    errorDetailKey: task.errorDetailKey,
    errorDetailParams: task.errorDetailParams,
    diagnosisRevision: task.diagnosisRevision,
    metadataProgress: 0,
    priority: task.priority,
    category: task.category,
    dlLimit: 0,
    ulLimit: 0,
    filename: task.finalName || task.name,
    sizeWhenDone: task.sizeWhenDone,
    source: task.source,
    sourceMeta: task.sourceMeta,
    diskPath: primary?.diskPath ?? '',
    finalPath: task.finalPath,
    finalName: task.finalName,
    transitionPhase: primary?.transitionPhase ?? TransitionPhase.Idle,
    torrentMetaPath: task.torrentMetaPath,
    bt,
    instances: instances.map((i) => ({ ...i })),
  }
}
