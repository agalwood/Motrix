import path from 'node:path'
import type { Aria2RawStatus } from '@core/engine/aria2/types'
import { TaskManager } from '@core/task/task-manager'
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
import { describe, expect, it, vi } from 'vitest'
import { type FinalizeTaskDeps, finalizeTask } from './actions/finalize-task'
import {
  btStoragePayload,
  createBtDirectStoragePlan,
  getBtDirectStorageLayout,
} from './bt-storage-layout'
import {
  buildDirectMagnetIdentityPatch,
  extractResolvedBtNameFromRaw,
  extractResolvedBtNameFromTask,
  needsDirectMagnetIdentityResolution,
} from './direct-magnet-identity'
import { hasEngineTaskDelta, mergeEngineTask } from './merge-engine-task'

const INFO_HASH = 'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc'

function makeUnresolvedDirectMagnetTask(
  overrides: Partial<DownloadTask> = {}
): DownloadTask {
  const saveDir = overrides.saveDir ?? '/downloads'
  const directPlan = createBtDirectStoragePlan(saveDir, null, null)
  return makeDownloadTask({
    id: overrides.id ?? 'magnet-task-1',
    engineTaskId: overrides.engineTaskId ?? 'bt-gid-1',
    name: overrides.name ?? INFO_HASH,
    filename: overrides.filename ?? INFO_HASH,
    kind: TaskKind.Bt,
    type: TaskType.Magnet,
    status: overrides.status ?? TaskStatus.Downloading,
    saveDir,
    diskPath: '',
    finalPath: saveDir,
    finalName: '',
    torrentMetaPath: null,
    infoHash: INFO_HASH,
    uris: [`magnet:?xt=urn:btih:${INFO_HASH}`],
    bt: makeDefaultBtExtension(),
    source: 'user',
    sourceMeta: null,
    createdAt: 1000,
    updatedAt: 1000,
    instances: [
      {
        instanceId: 'primary:magnet-task-1',
        motrixId: overrides.id ?? 'magnet-task-1',
        gid: overrides.engineTaskId ?? 'bt-gid-1',
        phase: TaskInstancePhase.BtDownload,
        status: overrides.status ?? TaskStatus.Downloading,
        progress: 0,
        totalBytes: 0,
        downloadedBytes: 0,
        uploadedBytes: 0,
        diskPath: '',
        transitionPhase: TransitionPhase.Idle,
        uris: [`magnet:?xt=urn:btih:${INFO_HASH}`],
        uriHash: null,
        payload: btStoragePayload(directPlan.layout),
        createdAt: 1000,
        updatedAt: 1000,
      },
    ],
    ...overrides,
  })
}

function makeFinalizeDeps(
  task: DownloadTask,
  liveSnapshot: DownloadTask | null
): {
  deps: FinalizeTaskDeps
  taskManager: TaskManager
  renameAtomic: ReturnType<typeof vi.fn>
} {
  const taskManager = new TaskManager()
  taskManager.set(task.id, structuredClone(task))
  const renameAtomic = vi.fn().mockResolvedValue(undefined)
  const deps: FinalizeTaskDeps = {
    taskManager: {
      getById: (id) => taskManager.getById(id),
      getAll: () => taskManager.getAll(),
      set: (id, next) => taskManager.set(id, next),
      setReservedEngineTaskOwner: (id, next, gid) =>
        taskManager.setReservedEngineTaskOwner(id, next, gid),
      reserveEngineTaskId: (gid) => taskManager.reserveEngineTaskId(gid),
      releaseEngineTaskIdReservation: (gid) =>
        taskManager.releaseEngineTaskIdReservation(gid),
      retireEngineTaskIdReservation: (gid) =>
        taskManager.retireEngineTaskIdReservation(gid),
      persist: vi.fn().mockResolvedValue(undefined),
    },
    publishTaskUpdate: vi.fn(),
    publishTaskUpdateNow: vi.fn(),
    adapter: {
      removeDownloadResult: vi.fn().mockResolvedValue(undefined),
      forceRemoveTask: vi.fn().mockResolvedValue(undefined),
      getUploadLength: vi.fn().mockResolvedValue(0),
      getTaskStatus: vi.fn().mockResolvedValue(liveSnapshot),
      getTaskFiles: vi.fn().mockResolvedValue([]),
      addTorrent: vi.fn().mockResolvedValue('reseed-gid'),
    },
    fs: {
      renameAtomic,
      removePathRecursive: vi.fn().mockResolvedValue(undefined),
    },
    torrentMetaStore: {
      read: vi.fn().mockRejectedValue(new Error('no meta')),
    },
    settings: {
      get: () => ({ bt: { seedTime: 0, seedRatio: 0 } }),
    },
    eventBus: { emit: vi.fn() },
    activityRecorder: {
      recordSubmitted: vi.fn(),
      recordDownloadCompleted: vi.fn(),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    finalNamePicker: {
      pick: vi.fn(async (_dir: string, desired: string) => desired),
    },
  }
  return { deps, taskManager, renameAtomic }
}

describe('direct-magnet-identity (#2569)', () => {
  it('detects unresolved direct magnet tasks and ignores parsed torrents', () => {
    const unresolved = makeUnresolvedDirectMagnetTask()
    expect(needsDirectMagnetIdentityResolution(unresolved)).toBe(true)

    const resolved = makeUnresolvedDirectMagnetTask({
      name: 'ubuntu.iso',
      filename: 'ubuntu.iso',
      finalName: 'ubuntu.iso',
      diskPath: '/downloads/ubuntu.iso',
      finalPath: '/downloads/ubuntu.iso',
    })
    expect(needsDirectMagnetIdentityResolution(resolved)).toBe(false)
  })

  it('extracts resolved BT root names from aria2 raw rows and translated tasks', () => {
    const rawFromInfo: Aria2RawStatus = {
      gid: 'bt-1',
      status: 'active',
      totalLength: '1024',
      completedLength: '512',
      uploadLength: '0',
      downloadSpeed: '100',
      uploadSpeed: '0',
      connections: '2',
      numSeeders: '1',
      seeder: 'false',
      pieceLength: '16384',
      numPieces: '1',
      dir: '/downloads',
      files: [],
      bittorrent: {
        announceList: [],
        mode: 'single',
        info: { name: 'ArchLinux.iso' },
      },
    }
    expect(extractResolvedBtNameFromRaw(rawFromInfo)).toBe('ArchLinux.iso')

    const rawFromFilePath: Aria2RawStatus = {
      ...rawFromInfo,
      bittorrent: { announceList: [], mode: 'multi', info: { name: '' } },
      files: [
        {
          index: '1',
          path: path.join('/downloads', 'Season 1', 'ep01.mkv'),
          length: '1024',
          completedLength: '512',
          selected: 'true',
          uris: [],
        },
      ],
    }
    expect(extractResolvedBtNameFromRaw(rawFromFilePath)).toBe('Season 1')

    const fetchingMeta = makeUnresolvedDirectMagnetTask({
      status: TaskStatus.FetchingMetadata,
      name: `[METADATA]${INFO_HASH}`,
      totalBytes: 0,
      fileCount: 0,
    })
    expect(extractResolvedBtNameFromTask(fetchingMeta, INFO_HASH)).toBeNull()

    const liveBt = makeUnresolvedDirectMagnetTask({
      status: TaskStatus.Downloading,
      name: 'ArchLinux.iso',
      totalBytes: 2048,
      fileCount: 1,
    })
    expect(extractResolvedBtNameFromTask(liveBt, INFO_HASH)).toBe(
      'ArchLinux.iso'
    )
  })

  it('heals direct magnet name/path on poll merge and finalizes in place without rename errors', async () => {
    const unresolved = makeUnresolvedDirectMagnetTask()
    const polledBt = makeUnresolvedDirectMagnetTask({
      name: 'ubuntu-24.04.iso',
      filename: 'ubuntu-24.04.iso',
      status: TaskStatus.Downloading,
      totalBytes: 10_000,
      downloadedBytes: 5_000,
      fileCount: 1,
      // translateRawToTask 对 BT 会把 derivedPaths 设为 raw.dir，不能覆盖成 saveDir
      diskPath: '/downloads',
      finalPath: '/downloads',
      finalName: 'downloads',
    })

    const merged = mergeEngineTask(unresolved, polledBt, 2000)
    expect(hasEngineTaskDelta(unresolved, merged)).toBe(true)
    expect(merged.name).toBe('ubuntu-24.04.iso')
    expect(merged.filename).toBe('ubuntu-24.04.iso')
    expect(merged.finalName).toBe('ubuntu-24.04.iso')
    expect(merged.finalPath).toBe(path.join('/downloads', 'ubuntu-24.04.iso'))
    expect(merged.diskPath).toBe(path.join('/downloads', 'ubuntu-24.04.iso'))
    expect(merged.instances[0]?.diskPath).toBe(
      path.join('/downloads', 'ubuntu-24.04.iso')
    )
    // 确认未原地修改原始实例数组
    expect(unresolved.instances[0]?.diskPath).toBe('')

    const completedLive = makeUnresolvedDirectMagnetTask({
      name: 'ubuntu-24.04.iso',
      status: TaskStatus.Seeding,
      totalBytes: 10_000,
      downloadedBytes: 10_000,
      sizeWhenDone: 10_000,
      fileCount: 1,
    })
    const { deps, taskManager, renameAtomic } = makeFinalizeDeps(
      merged,
      completedLive
    )
    await finalizeTask(merged.id, deps)

    expect(renameAtomic).not.toHaveBeenCalled()
    const finalized = taskManager.getById(merged.id)
    expect(finalized?.status).toBe(TaskStatus.Seeding)
    expect(finalized?.errorMessage).toBeNull()
    expect(getBtDirectStorageLayout(finalized!)?.finalized).toBe(true)
  })

  it('refreshes unresolved direct magnet identity inside finalizeBt when completion races polling', async () => {
    const unresolved = makeUnresolvedDirectMagnetTask({
      status: TaskStatus.Downloading,
      totalBytes: 10_000,
      downloadedBytes: 10_000,
    })
    const liveSeeding = makeUnresolvedDirectMagnetTask({
      name: 'fast-finish.mkv',
      status: TaskStatus.Seeding,
      totalBytes: 10_000,
      downloadedBytes: 10_000,
      sizeWhenDone: 10_000,
      fileCount: 1,
    })

    const { deps, taskManager, renameAtomic } = makeFinalizeDeps(
      unresolved,
      liveSeeding
    )
    await finalizeTask(unresolved.id, deps)

    expect(renameAtomic).not.toHaveBeenCalled()
    const finalized = taskManager.getById(unresolved.id)
    expect(finalized?.status).toBe(TaskStatus.Seeding)
    expect(finalized?.name).toBe('fast-finish.mkv')
    expect(finalized?.finalPath).toBe(
      path.join('/downloads', 'fast-finish.mkv')
    )
    expect(finalized?.diskPath).toBe(path.join('/downloads', 'fast-finish.mkv'))
    expect(getBtDirectStorageLayout(finalized!)?.finalized).toBe(true)
  })

  it('sanitizes unsafe path separators when building direct magnet identity patches', () => {
    const patch = buildDirectMagnetIdentityPatch(
      { saveDir: '/downloads' },
      '../escape/name.iso'
    )
    expect(patch?.finalName).toBe('.._escape_name.iso')
    expect(patch?.finalPath).toBe(path.join('/downloads', '.._escape_name.iso'))
  })
})
