import path from 'node:path'
import {
  type DownloadTask,
  makeDefaultBtExtension,
  makeDownloadTask,
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { describe, expect, it } from 'vitest'
import {
  inspectBtDuplicate,
  normalizeBtInfoHash,
  reservedBtFinalNames,
} from './bt-duplicate-policy'

const INFO_HASH = 'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc'

function btTask(
  overrides: Partial<DownloadTask> & Pick<DownloadTask, 'id' | 'status'>
): DownloadTask {
  const saveDir = overrides.saveDir ?? '/downloads'
  const finalName = overrides.finalName ?? 'sample-data'
  const now = 1
  return makeDownloadTask({
    ...overrides,
    id: overrides.id,
    engineTaskId: `${overrides.id}-gid`,
    name: finalName,
    kind: TaskKind.Bt,
    type: overrides.type ?? TaskType.Bt,
    status: overrides.status,
    saveDir,
    createdAt: now,
    updatedAt: now,
    filename: finalName,
    diskPath: overrides.diskPath ?? path.join(saveDir, '.motrix', overrides.id),
    finalPath: overrides.finalPath ?? path.join(saveDir, finalName),
    finalName,
    infoHash: INFO_HASH,
    bt: makeDefaultBtExtension({ selectedFiles: [0, 2] }),
    source: 'user',
    sourceMeta: null,
    instances: [
      {
        instanceId: `primary:${overrides.id}`,
        motrixId: overrides.id,
        gid: `${overrides.id}-gid`,
        phase:
          overrides.type === TaskType.Magnet
            ? TaskInstancePhase.MagnetMetadataResolution
            : TaskInstancePhase.BtDownload,
        status: overrides.status,
        progress: 0,
        totalBytes: 0,
        downloadedBytes: 0,
        uploadedBytes: 0,
        diskPath:
          overrides.diskPath ?? path.join(saveDir, '.motrix', overrides.id),
        transitionPhase: TransitionPhase.Idle,
        uris: [],
        uriHash: null,
        payload: {},
        createdAt: now,
        updatedAt: now,
      },
    ],
  })
}

describe('inspectBtDuplicate', () => {
  it('reuses an exact active task without starting another info hash owner', () => {
    const task = btTask({ id: 'seed', status: TaskStatus.Seeding })

    expect(
      inspectBtDuplicate([task], {
        infoHash: INFO_HASH.toUpperCase(),
        saveDir: '/downloads',
        selectedFiles: [2, 0, 2],
        duplicatePolicy: 'reuse',
      })
    ).toEqual({ action: 'reuse', task, recheck: false })
  })

  it('reuses a completed task through an integrity recheck', () => {
    const task = btTask({ id: 'done', status: TaskStatus.Completed })

    expect(
      inspectBtDuplicate([task], {
        infoHash: INFO_HASH,
        saveDir: '/downloads',
        selectedFiles: [0, 2],
        duplicatePolicy: 'reuse',
      })
    ).toEqual({ action: 'reuse', task, recheck: true })
  })

  it('does not recheck a terminal duplicate while a legacy live owner exists', () => {
    const completed = btTask({ id: 'done', status: TaskStatus.Completed })
    const active = btTask({
      id: 'active-other-dir',
      status: TaskStatus.Downloading,
      saveDir: '/other',
      finalPath: '/other/sample-data',
    })

    expect(
      inspectBtDuplicate([completed, active], {
        infoHash: INFO_HASH,
        saveDir: '/downloads',
        selectedFiles: [0, 2],
        duplicatePolicy: 'reuse',
      })
    ).toMatchObject({
      action: 'conflict',
      conflict: {
        reason: 'active-info-hash',
        existingTaskId: active.id,
        canCreateCopy: false,
      },
    })
  })

  it('requires an explicit copy for a different selection in one directory', () => {
    const task = btTask({ id: 'done', status: TaskStatus.Completed })

    const result = inspectBtDuplicate([task], {
      infoHash: INFO_HASH,
      saveDir: '/downloads',
      selectedFiles: [1],
      duplicatePolicy: 'reuse',
    })

    expect(result).toMatchObject({
      action: 'conflict',
      conflict: {
        reason: 'selection-mismatch',
        existingTaskId: 'done',
        canCreateCopy: true,
      },
    })
  })

  it('blocks an independent copy while aria2 has the info hash registered', () => {
    const task = btTask({
      id: 'active-other-dir',
      status: TaskStatus.Downloading,
      saveDir: '/other',
      finalPath: '/other/sample-data',
    })

    const result = inspectBtDuplicate([task], {
      infoHash: INFO_HASH,
      saveDir: '/downloads',
      selectedFiles: [0, 2],
      duplicatePolicy: 'create-copy',
    })

    expect(result).toMatchObject({
      action: 'conflict',
      conflict: { reason: 'active-info-hash', canCreateCopy: false },
    })
  })

  it('treats an Error owner as registered until retry or removal cleans it', () => {
    const task = btTask({
      id: 'quarantined-error',
      status: TaskStatus.Error,
      saveDir: '/other',
      finalPath: '/other/sample-data',
    })

    expect(
      inspectBtDuplicate([task], {
        infoHash: INFO_HASH,
        saveDir: '/downloads',
        selectedFiles: [0, 2],
        duplicatePolicy: 'create-copy',
      })
    ).toMatchObject({
      action: 'conflict',
      conflict: { reason: 'active-info-hash', canCreateCopy: false },
    })
  })

  it('allows the same content in a different directory after it is terminal', () => {
    const task = btTask({
      id: 'done-other-dir',
      status: TaskStatus.Completed,
      saveDir: '/other',
      finalPath: '/other/sample-data',
    })

    expect(
      inspectBtDuplicate([task], {
        infoHash: INFO_HASH,
        saveDir: '/downloads',
        selectedFiles: [0, 2],
        duplicatePolicy: 'reuse',
      })
    ).toEqual({ action: 'create' })
  })

  it('allows a different directory after metadata-only aria2 cleanup', () => {
    const task = btTask({
      id: 'metadata-ready-other-dir',
      status: TaskStatus.MetadataReady,
      type: TaskType.Magnet,
      saveDir: '/other',
      finalName: '',
      finalPath: '/other',
    })

    expect(
      inspectBtDuplicate([task], {
        infoHash: INFO_HASH,
        saveDir: '/downloads',
        selectedFiles: [0, 2],
        duplicatePolicy: 'reuse',
      })
    ).toEqual({ action: 'create' })
  })
})

it('reserves final names that are still hidden in indexed workspaces', () => {
  const task = btTask({ id: 'hidden', status: TaskStatus.Downloading })
  expect(reservedBtFinalNames([task], '/downloads')).toEqual(['sample-data'])
})

it('normalizes base32 BTIH values to the canonical hexadecimal identity', () => {
  expect(normalizeBtInfoHash('UA7D7GQFGQNKGNXJ3HJ7A2ZTZXNP4C64')).toBe(
    INFO_HASH
  )
})
