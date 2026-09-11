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
import { btStoragePayload, createBtStoragePlan } from './bt-storage-layout'
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
  it.each([
    ['g1', 25, 125],
    ['reseed-gid', 10, 135],
  ])(
    'restores settled upload for %s without double counting',
    (gid, upload, expected) => {
      const primary = makeInstance(TaskInstancePhase.BtDownload)
      primary.gid = gid
      primary.uploadedBytes = upload
      primary.payload.btFinalizeUpload = { gid: 'g1', bytes: 25 }
      const restored = taskRowToDownloadTask(
        makeTaskRow({ uploadedBytesBaseline: 125 }),
        [primary]
      )
      expect(restored.uploadedBytes).toBe(expected)
    }
  )

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

describe('persisted save directory', () => {
  it('recovers the root from an older BT staging container before publication', () => {
    const task = taskRowToDownloadTask(
      makeTaskRow({ finalPath: '/Downloads/Movies/video' }),
      [makeInstance(TaskInstancePhase.BtDownload)]
    )
    expect(task.saveDir).toBe('/Downloads')
  })

  it('recovers the legacy root after a BT artifact moved into a plugin subdirectory', () => {
    const plan = createBtStoragePlan('t1', '/Downloads', {
      infoHash: 'a'.repeat(40),
      torrentRootName: 'video',
      multiFile: false,
      isPrivate: false,
      files: [{ fileIndex: 0, pathInsideRoot: null }],
    })
    const finalPath = '/Downloads/Movies/video'
    const task = taskRowToDownloadTask(
      makeTaskRow({ finalPath, aggStatus: TaskStatus.Completed }),
      [
        {
          ...makeInstance(TaskInstancePhase.BtDownload),
          diskPath: finalPath,
          payload: btStoragePayload(plan.layout),
        },
      ]
    )
    expect(task.saveDir).toBe('/Downloads')
    expect(task.diskPath).toBe(finalPath)
  })

  it('preserves the selected root independently of a plugin-selected final path', () => {
    const task = taskRowToDownloadTask(
      makeTaskRow({
        saveDir: '/Downloads',
        finalPath: '/Downloads/Movies/video',
      }),
      [makeInstance(TaskInstancePhase.BtDownload)]
    )
    expect(task.saveDir).toBe('/Downloads')
  })

  it('keeps the directory stored in a legacy metadata-only magnet task', () => {
    const task = taskRowToDownloadTask(
      makeTaskRow({
        taskType: TaskType.Magnet,
        finalPath: '/Downloads',
      }),
      [makeInstance(TaskInstancePhase.MagnetMetadataResolution)]
    )
    expect(task.saveDir).toBe('/Downloads')
  })
})
