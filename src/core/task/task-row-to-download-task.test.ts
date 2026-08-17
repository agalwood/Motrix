import type { TaskInstanceRow, TaskRow } from '@core/session/motrix-database'
import { DownloadErrorCode } from '@shared/errors'
import {
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { describe, expect, it } from 'vitest'
import { taskRowToDownloadTask } from './task-row-to-download-task'

function makeTaskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    motrixId: 't1',
    name: 'video',
    kind: TaskKind.Bt,
    taskType: TaskType.Bt,
    category: null,
    priority: 0,
    tags: null,
    createdAt: 1700000000,
    updatedAt: 1700000001,
    finalPath: '/Downloads/video',
    finalName: 'video',
    torrentMetaPath: null,
    infoHash: null,
    totalBytes: 0,
    downloadedBytes: 0,
    sizeWhenDone: 0,
    fileCount: 0,
    isPrivate: false,
    trackers: [],
    pieceLength: 0,
    aggStatus: TaskStatus.Downloading,
    finishedAt: null,
    errorMessage: null,
    errorCode: null,
    errorDetailKey: null,
    errorDetailParams: null,
    diagnosisRevision: 0,
    uploadedBytesBaseline: 0,
    source: 'user',
    sourceMeta: null,
    ...overrides,
  }
}

function makeInstance(phase: TaskInstancePhase): TaskInstanceRow {
  return {
    instanceId: `i:${phase}`,
    motrixId: 't1',
    gid: 'g1',
    phase,
    status: TaskStatus.Downloading,
    progress: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    uploadedBytes: 0,
    diskPath: '/Downloads/video.motrix',
    transitionPhase: TransitionPhase.Idle,
    uris: [],
    uriHash: null,
    payload: {},
    createdAt: 1700000000,
    updatedAt: 1700000001,
  }
}

describe('taskRowToDownloadTask', () => {
  it('uses the canonical persisted BT type', () => {
    const task = taskRowToDownloadTask(makeTaskRow(), [
      makeInstance(TaskInstancePhase.BtDownload),
    ])
    expect(task.type).toBe(TaskType.Bt)
  })

  it('uses the canonical persisted Magnet type without phase inference', () => {
    const task = taskRowToDownloadTask(
      makeTaskRow({ taskType: TaskType.Magnet }),
      [makeInstance(TaskInstancePhase.MagnetMetadataResolution)]
    )
    expect(task.type).toBe(TaskType.Magnet)
  })

  it('preserves terminal, organization, byte, and path fields', () => {
    const task = taskRowToDownloadTask(
      makeTaskRow({
        taskType: TaskType.Metalink,
        kind: TaskKind.Direct,
        category: 'work',
        priority: 7,
        totalBytes: 1000,
        downloadedBytes: 400,
        sizeWhenDone: 1000,
        fileCount: 3,
        pieceLength: 256,
        aggStatus: TaskStatus.Error,
        finishedAt: 1234,
        errorMessage: 'failed',
        errorCode: DownloadErrorCode.NetworkError,
      }),
      [makeInstance(TaskInstancePhase.HttpDownload)]
    )

    expect(task).toMatchObject({
      type: TaskType.Metalink,
      kind: TaskKind.Direct,
      category: 'work',
      priority: 7,
      totalBytes: 1000,
      downloadedBytes: 400,
      sizeWhenDone: 1000,
      fileCount: 3,
      pieceLength: 256,
      status: TaskStatus.Error,
      finishedAt: 1234,
      errorMessage: 'failed',
      errorCode: DownloadErrorCode.NetworkError,
      diskPath: '/Downloads/video.motrix',
      finalPath: '/Downloads/video',
    })
  })
})
