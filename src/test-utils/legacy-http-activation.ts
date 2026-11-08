import { createHash } from 'node:crypto'
import path from 'node:path'
import type { LegacyHttpActivation } from '@shared/schemas/legacy-http-activation'
import type { LegacyTaskMetadata } from '@shared/schemas/legacy-import'
import {
  type DownloadTask,
  TaskInstancePhase,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { makeDownloadTask } from './task'

/** A validated in-place HTTP migration with one immutable original source. */
export function makeLegacyHttpTask(
  overrides: Partial<DownloadTask> = {}
): DownloadTask {
  const id = overrides.id ?? 'legacy-http'
  const gid = overrides.engineTaskId ?? '1234567890abcdef'
  const targetPath = overrides.finalPath ?? '/original/file.bin'
  const uris = overrides.uris ?? ['https://example.com/file.bin']
  const status = overrides.status ?? TaskStatus.Paused
  const totalBytes = overrides.totalBytes ?? 1024
  const downloadedBytes = overrides.downloadedBytes ?? 512
  const intent: LegacyHttpActivation = {
    version: 1,
    stage: 'active',
    token: 'legacy-http-token',
    engineTaskId: gid,
    targetPath,
    saveDir: path.dirname(targetPath),
    rootIdentity: '1:2:0:0:0',
    controlBackupPath: '/metadata/control.backup',
    controlIdentity: '1:3:100:0:0',
    controlDigest: 'a'.repeat(64),
    uriDigest: createHash('sha256').update(uris[0]).digest('hex'),
    expected: {
      type: 'http',
      totalBytes,
      pieceBytes: 512,
      infoHash: null,
    },
    files: [
      {
        path: targetPath,
        offset: 0,
        length: totalBytes,
        identity: {
          device: '1',
          inode: '2',
          size: String(totalBytes),
          mtimeNs: '0',
          ctimeNs: '0',
        },
      },
    ],
    completedBytes: downloadedBytes,
    resourceValidator: {
      kind: 'strong-etag',
      value: '"original"',
      contentLength: totalBytes,
      capturedAt: 1,
    },
  }
  const marker: LegacyTaskMetadata = {
    version: 1,
    sourceId: 'source',
    itemKey: 'item',
    activation: 'active',
    storagePolicy: 'legacy-http-in-place',
    reason: 'verification-required',
    selectionKnown: true,
    selectedFiles: [0],
  }
  return makeDownloadTask({
    id,
    engineTaskId: gid,
    name: path.basename(targetPath),
    type: TaskType.Http,
    status,
    saveDir: path.dirname(targetPath),
    diskPath: targetPath,
    finalPath: targetPath,
    finalName: path.basename(targetPath),
    totalBytes,
    downloadedBytes,
    sizeWhenDone: totalBytes,
    progress: downloadedBytes / totalBytes,
    fileCount: 1,
    pieceLength: 512,
    uris,
    instances: [
      {
        instanceId: `primary:${id}`,
        motrixId: id,
        gid,
        phase: TaskInstancePhase.HttpDownload,
        status,
        progress: (downloadedBytes / totalBytes) * 100,
        totalBytes,
        downloadedBytes,
        uploadedBytes: 0,
        diskPath: targetPath,
        transitionPhase: TransitionPhase.Idle,
        uris: [...uris],
        uriHash: null,
        payload: { legacyImport: marker, legacyHttpActivation: intent },
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    ...overrides,
  })
}
