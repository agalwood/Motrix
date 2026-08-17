// Shared DownloadTask fixture for tests. Centralizes the ~40-field shape so a
// new required field gets one default here instead of breaking every test that
// hand-rolled its own factory.
//
// Defaults are deliberately NEUTRAL (zero / empty / null, status Downloading,
// kind Direct). Each test overrides only the fields it asserts on; callers that
// need a populated baseline pass those values via `overrides`.

import type { DownloadTask } from '@shared/types/task'
import {
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'

export function makeDownloadTask(
  overrides: Partial<DownloadTask> = {}
): DownloadTask {
  return {
    id: 'task-1',
    engineTaskId: 'gid-1',
    name: 'task',
    type: TaskType.Http,
    status: TaskStatus.Downloading,
    progress: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    etaSeconds: 0,
    saveDir: '',
    createdAt: 0,
    updatedAt: 0,
    finishedAt: null,
    errorMessage: null,
    uris: [],
    uploadedBytes: 0,
    uploadedBytesBaseline: 0,
    fileCount: 0,
    connections: 0,
    pieceLength: 0,
    infoHash: null,
    errorCode: null,
    errorDetailKey: null,
    errorDetailParams: null,
    diagnosisRevision: 0,
    metadataProgress: 0,
    priority: 0,
    category: null,
    dlLimit: 0,
    ulLimit: 0,
    filename: '',
    sizeWhenDone: 0,
    source: 'user',
    sourceMeta: null,
    diskPath: '',
    finalPath: '',
    finalName: '',
    transitionPhase: TransitionPhase.Idle,
    torrentMetaPath: null,
    kind: TaskKind.Direct,
    instances: [],
    ...overrides,
  }
}
