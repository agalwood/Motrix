import type { TaskInstanceRow, TaskRow } from '@core/session/motrix-database'
import {
  type TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
export function makeTaskRow(motrixId: string, kind: TaskKind): TaskRow {
  return {
    motrixId,
    name: motrixId,
    kind,
    taskType: kind === TaskKind.Bt ? TaskType.Bt : TaskType.Http,
    category: null,
    priority: 0,
    tags: null,
    createdAt: 1700000000,
    updatedAt: 1700000001,
    finalPath: '',
    finalName: '',
    torrentMetaPath: null,
    infoHash: null,
    totalBytes: 0,
    downloadedBytes: 0,
    sizeWhenDone: 0,
    fileCount: 0,
    isPrivate: false,
    trackers: [],
    pieceLength: 0,
    aggStatus: TaskStatus.Queued,
    finishedAt: null,
    errorMessage: null,
    errorCode: null,
    errorDetailKey: null,
    errorDetailParams: null,
    diagnosisRevision: 0,
    uploadedBytesBaseline: 0,
    source: 'user',
    sourceMeta: null,
  }
}

export function makeInstanceRow(
  instanceId: string,
  motrixId: string,
  gid: string | null,
  phase: TaskInstancePhase
): TaskInstanceRow {
  return {
    instanceId,
    motrixId,
    gid,
    phase,
    status: TaskStatus.Queued,
    progress: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    uploadedBytes: 0,
    diskPath: '',
    transitionPhase: TransitionPhase.Idle,
    uris: [],
    uriHash: null,
    payload: {},
    createdAt: 1700000000,
    updatedAt: 1700000001,
  }
}
