import type {
  MotrixDatabase,
  TaskFileRow,
  TaskInstanceRow,
  TaskRow,
  TaskWithInstances,
  TaskWithInstancesAndFiles,
} from '@core/session/motrix-database'
import type { TaskManager } from '@core/task/task-manager'
import { AppError, ErrorCode } from '@shared/errors'
import { Events } from '@shared/protocol/events'
import type { DownloadTask } from '@shared/types/task'
import {
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MagnetTracker } from './magnet-tracker'
import {
  type SwapMagnetMetadataDeps,
  swapMagnetMetadataForBt,
} from './swap-magnet-metadata-for-bt'

// Stub node:fs/promises so the swap's `mkdir(diskPath, {recursive:true})`
// (the in-flight .motrix container pre-create) doesn't touch the real FS.
const { mkdirMock, rmMock } = vi.hoisted(() => ({
  mkdirMock: vi.fn(async () => undefined),
  rmMock: vi.fn(async () => undefined),
}))
vi.mock('node:fs/promises', () => ({
  mkdir: mkdirMock,
  rm: rmMock,
  default: { mkdir: mkdirMock, rm: rmMock },
}))

// ─── Fixtures ───────────────────────────────────────────────────

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve
  })
  return { promise, resolve }
}

function createMutationAdmission() {
  let tail: Promise<void> = Promise.resolve()
  const calls: Array<readonly string[]> = []
  const runTaskMutation: SwapMagnetMetadataDeps['runTaskMutation'] = <T>(
    taskIds: readonly string[],
    operation: () => Promise<T>
  ): Promise<T> => {
    calls.push(taskIds)
    const current = tail.then(operation, operation)
    tail = current.then(
      () => undefined,
      () => undefined
    )
    return current
  }
  return { calls, runTaskMutation }
}

function runImmediately<T>(
  _taskIds: readonly string[],
  operation: () => Promise<T>
): Promise<T> {
  return operation()
}

function persistImmediately<T>(operation: () => T | Promise<T>): Promise<T> {
  return Promise.resolve().then(operation)
}

function createPersistenceQueue(): SwapMagnetMetadataDeps['runExclusivePersistence'] {
  let tail: Promise<void> = Promise.resolve()
  return <T>(operation: () => T | Promise<T>): Promise<T> => {
    const current = tail.then(operation, operation)
    tail = current.then(
      () => undefined,
      () => undefined
    )
    return current
  }
}

function createMockDb(): MotrixDatabase {
  const tasks = new Map<string, TaskRow>()
  const instances = new Map<string, TaskInstanceRow[]>()
  const files = new Map<string, TaskFileRow[]>()
  return {
    saveTaskWithInstances: vi.fn((p: TaskWithInstances) => {
      tasks.set(p.task.motrixId, p.task)
      instances.set(p.task.motrixId, p.instances)
    }),
    saveTaskWithInstancesAndFiles: vi.fn((p: TaskWithInstancesAndFiles) => {
      tasks.set(p.task.motrixId, p.task)
      instances.set(p.task.motrixId, p.instances)
      files.set(p.task.motrixId, p.files)
    }),
    getTask: vi.fn((id: string) => {
      const task = tasks.get(id)
      if (!task) return null
      return { task, instances: instances.get(id) ?? [] }
    }),
    replaceInstances: vi.fn((id: string, rows: TaskInstanceRow[]) => {
      instances.set(id, rows)
    }),
    replaceTaskFiles: vi.fn((id: string, rows: TaskFileRow[]) => {
      files.set(id, rows)
    }),
    deleteTask: vi.fn((id: string) => {
      tasks.delete(id)
      instances.delete(id)
      files.delete(id)
    }),
    getTaskFiles: vi.fn((id: string) => files.get(id) ?? []),
  } as unknown as MotrixDatabase
}

function createMockTaskManager(): TaskManager {
  const tasks = new Map<string, DownloadTask>()
  const reservations = new Set<string>()
  const retired = new Set<string>()
  const gidsFor = (task: DownloadTask): string[] => [
    ...task.instances.flatMap((instance) =>
      instance.gid ? [instance.gid] : []
    ),
    ...(task.engineTaskId ? [task.engineTaskId] : []),
  ]
  const store = (id: string, task: DownloadTask, claim: boolean): void => {
    tasks.set(id, task)
    if (claim) {
      for (const gid of gidsFor(task)) reservations.delete(gid)
    }
  }
  return {
    set: vi.fn((id: string, task: DownloadTask) => store(id, task, true)),
    reserveEngineTaskId: vi.fn((gid: string) => {
      if (reservations.has(gid) || retired.has(gid)) {
        throw new Error(`Engine task id is not available: ${gid}`)
      }
      reservations.add(gid)
    }),
    releaseEngineTaskIdReservation: vi.fn((gid: string) =>
      reservations.delete(gid)
    ),
    retireEngineTaskIdReservation: vi.fn((gid: string) => {
      if (!reservations.delete(gid)) return false
      retired.add(gid)
      return true
    }),
    isEngineTaskIdRetired: vi.fn(
      (gid: string) => reservations.has(gid) || retired.has(gid)
    ),
    setReservedEngineTaskOwner: vi.fn(
      (id: string, task: DownloadTask, gid: string) => {
        if (!reservations.has(gid)) {
          throw new Error(`Engine task id is not reserved: ${gid}`)
        }
        store(id, task, false)
      }
    ),
    rollbackReservedEngineTaskOwner: vi.fn(
      (id: string, gid: string, replacement?: DownloadTask): boolean => {
        if (!reservations.has(gid)) return false
        tasks.delete(id)
        reservations.delete(gid)
        if (replacement) store(id, replacement, true)
        return true
      }
    ),
    getById: vi.fn((id: string) => tasks.get(id)),
    getByEngineTaskId: vi.fn((gid: string) =>
      [...tasks.values()].find(
        (task) =>
          task.engineTaskId === gid ||
          task.instances.some((instance) => instance.gid === gid)
      )
    ),
    remove: vi.fn((id: string) => {
      const task = tasks.get(id)
      if (task) {
        for (const gid of gidsFor(task)) retired.add(gid)
      }
      return tasks.delete(id)
    }),
    getAll: vi.fn(() => [...tasks.values()]),
  } as unknown as TaskManager
}

function makeTaskRow(motrixId: string): TaskRow {
  return {
    motrixId,
    name: `[METADATA] ${motrixId}`,
    kind: TaskKind.Bt,
    taskType: TaskType.Magnet,
    category: null,
    priority: 0,
    tags: null,
    createdAt: 1700000000,
    updatedAt: 1700000001,
    finalPath: '/Downloads',
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
    aggStatus: TaskStatus.MetadataReady,
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

function makeMetaInstance(motrixId: string, gid: string): TaskInstanceRow {
  return {
    instanceId: `meta:${motrixId}`,
    motrixId,
    gid,
    phase: TaskInstancePhase.MagnetMetadataResolution,
    status: TaskStatus.MetadataReady,
    progress: 100,
    totalBytes: 0,
    downloadedBytes: 0,
    uploadedBytes: 0,
    diskPath: '/tmp/motrix-magnet-metadata-x',
    transitionPhase: TransitionPhase.Idle,
    uris: ['magnet:?xt=urn:btih:abc'],
    uriHash: null,
    payload: { metadataDir: '/tmp/motrix-magnet-metadata-x' },
    createdAt: 1700000000,
    updatedAt: 1700000001,
  }
}

interface MockAdapter {
  addTorrent: ReturnType<typeof vi.fn>
  getTaskFiles: ReturnType<typeof vi.fn>
  forceRemoveTask: ReturnType<typeof vi.fn>
  removeDownloadResult: ReturnType<typeof vi.fn>
}

function createMockAdapter(): MockAdapter {
  return {
    addTorrent: vi.fn(async (params: { gid?: string }) => {
      if (!params.gid) throw new Error('test expected a caller-reserved gid')
      return params.gid
    }),
    getTaskFiles: vi.fn(async () => []),
    forceRemoveTask: vi.fn().mockResolvedValue(undefined),
    removeDownloadResult: vi.fn().mockResolvedValue(undefined),
  }
}

interface MockTracker {
  cancel: ReturnType<typeof vi.fn>
  hasPendingSwapCleanup: ReturnType<typeof vi.fn>
  reserveFailedSwapCleanup: ReturnType<typeof vi.fn>
  releaseFailedSwapCleanup: ReturnType<typeof vi.fn>
  registerFailedSwapCleanup: ReturnType<typeof vi.fn>
  observe: ReturnType<typeof vi.fn<(raw: { gid: string }) => boolean>>
}

function createMockTracker(
  cancelResult: 'removed' | 'quarantined' = 'removed'
): MockTracker {
  const shieldedGids = new Set<string>()
  return {
    cancel: vi.fn().mockResolvedValue(cancelResult),
    hasPendingSwapCleanup: vi.fn().mockReturnValue(false),
    reserveFailedSwapCleanup: vi.fn((input: { gid: string }) => {
      shieldedGids.add(input.gid)
    }),
    releaseFailedSwapCleanup: vi.fn((_taskId: string, gid: string) => {
      shieldedGids.delete(gid)
    }),
    registerFailedSwapCleanup: vi.fn((input: { gid: string }) => {
      shieldedGids.add(input.gid)
    }),
    observe: vi.fn((raw: { gid: string }) => shieldedGids.has(raw.gid)),
  }
}

interface MockEventBus {
  emit: ReturnType<typeof vi.fn<(event: string, payload: unknown) => void>>
}

function createMockEventBus(): MockEventBus {
  return { emit: vi.fn<(event: string, payload: unknown) => void>() }
}

function buildSingleFileTorrent(name: string): Uint8Array {
  const nameField = `4:name${Buffer.byteLength(name, 'utf8')}:${name}`
  const prefix = Buffer.from(
    `d4:infod6:lengthi1024e${nameField}12:piece lengthi16384e6:pieces20:`,
    'utf8'
  )
  return new Uint8Array(
    Buffer.concat([prefix, Buffer.alloc(20), Buffer.from('ee')])
  )
}

// ─── Tests ──────────────────────────────────────────────────────

describe('swapMagnetMetadataForBt', () => {
  let db: MotrixDatabase
  let taskManager: TaskManager
  let adapter: MockAdapter
  let magnetTracker: MockTracker
  let eventBus: MockEventBus
  let finalNamePicker: { pick: ReturnType<typeof vi.fn> }
  let torrentMetaStore: {
    persist: ReturnType<typeof vi.fn>
    remove: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    mkdirMock.mockClear()
    rmMock.mockClear()
    db = createMockDb()
    taskManager = createMockTaskManager()
    adapter = createMockAdapter()
    magnetTracker = createMockTracker('removed')
    eventBus = createMockEventBus()
    // Identity picker: no collision suffix unless a test overrides it.
    finalNamePicker = {
      pick: vi.fn(async (_saveDir: string, name: string) => name),
    }
    torrentMetaStore = {
      persist: vi.fn(async (taskId: string) => `/u/torrents/${taskId}.torrent`),
      remove: vi.fn(async () => undefined),
    }
    db.saveTaskWithInstances({
      task: makeTaskRow('m-mag'),
      instances: [makeMetaInstance('m-mag', 'g-meta')],
    })
  })

  it('removes the prepared container when torrent metadata persistence rejects', async () => {
    torrentMetaStore.persist.mockRejectedValueOnce(
      new Error('torrent metadata write failed')
    )

    await expect(
      swapMagnetMetadataForBt(
        {
          taskId: 'm-mag',
          base64: 'BASE64TORRENT==',
          selectedFiles: [0],
          saveDir: '/Downloads',
        },
        {
          db,
          taskManager,
          adapter: adapter as never,
          magnetTracker: magnetTracker as never as MagnetTracker,
          publishTaskUpdate: () =>
            eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
          publishTaskUpdateNow: () =>
            eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
          finalNamePicker: finalNamePicker as never,
          torrentMetaStore: torrentMetaStore as never,
          runTaskMutation: runImmediately,
          runExclusivePersistence: persistImmediately,
        }
      )
    ).rejects.toThrow('torrent metadata write failed')

    expect(adapter.addTorrent).not.toHaveBeenCalled()
    expect(magnetTracker.cancel).not.toHaveBeenCalled()
    expect(magnetTracker.reserveFailedSwapCleanup).not.toHaveBeenCalled()
    expect(rmMock).toHaveBeenCalledWith('/Downloads/m-mag.motrix', {
      recursive: true,
      force: true,
    })
    expect(db.getTask('m-mag')).toMatchObject({
      task: {
        taskType: TaskType.Magnet,
        aggStatus: TaskStatus.MetadataReady,
      },
      instances: [
        expect.objectContaining({
          gid: 'g-meta',
          phase: TaskInstancePhase.MagnetMetadataResolution,
        }),
      ],
    })
  })

  it('rejects a sequential duplicate confirmation before creating another gid', async () => {
    const admission = createMutationAdmission()
    const deps = {
      db,
      taskManager,
      adapter: adapter as never,
      magnetTracker: magnetTracker as never as MagnetTracker,
      publishTaskUpdate: () =>
        eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
      publishTaskUpdateNow: () =>
        eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
      finalNamePicker: finalNamePicker as never,
      torrentMetaStore: torrentMetaStore as never,
      runTaskMutation: admission.runTaskMutation,
      runExclusivePersistence: persistImmediately,
    }
    const input = {
      taskId: 'm-mag',
      base64: 'BASE64TORRENT==',
      selectedFiles: [0, 1],
      saveDir: '/Downloads',
      name: 'video.mp4',
    }

    const first = await swapMagnetMetadataForBt(input, deps)
    await expect(swapMagnetMetadataForBt(input, deps)).rejects.toMatchObject({
      code: ErrorCode.InvalidSelection,
    })

    expect(admission.calls).toEqual([['m-mag'], ['m-mag']])
    expect(adapter.addTorrent).toHaveBeenCalledTimes(1)
    expect(db.getTask('m-mag')?.instances).toEqual([
      expect.objectContaining({
        gid: first.gid,
        phase: TaskInstancePhase.BtDownload,
      }),
    ])
    expect(taskManager.getByEngineTaskId(first.gid)?.id).toBe('m-mag')
  })

  it.each([
    {
      seam: 'parent status',
      taskStatus: TaskStatus.FetchingMetadata,
      instancePhase: TaskInstancePhase.MagnetMetadataResolution,
      instanceStatus: TaskStatus.MetadataReady,
    },
    {
      seam: 'instance phase',
      taskStatus: TaskStatus.MetadataReady,
      instancePhase: TaskInstancePhase.BtDownload,
      instanceStatus: TaskStatus.MetadataReady,
    },
    {
      seam: 'instance status',
      taskStatus: TaskStatus.MetadataReady,
      instancePhase: TaskInstancePhase.MagnetMetadataResolution,
      instanceStatus: TaskStatus.FetchingMetadata,
    },
  ])(
    'rejects an invalid $seam before teardown or artifact preparation',
    async ({ taskStatus, instancePhase, instanceStatus }) => {
      db.saveTaskWithInstances({
        task: {
          ...makeTaskRow('m-mag'),
          aggStatus: taskStatus,
        },
        instances: [
          {
            ...makeMetaInstance('m-mag', 'g-meta'),
            phase: instancePhase,
            status: instanceStatus,
          },
        ],
      })
      vi.mocked(db.saveTaskWithInstancesAndFiles).mockClear()

      await expect(
        swapMagnetMetadataForBt(
          {
            taskId: 'm-mag',
            base64: 'BASE64TORRENT==',
            selectedFiles: [0],
            saveDir: '/Downloads',
          },
          {
            db,
            taskManager,
            adapter: adapter as never,
            magnetTracker: magnetTracker as never as MagnetTracker,
            publishTaskUpdate: () =>
              eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
            publishTaskUpdateNow: () =>
              eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
            finalNamePicker: finalNamePicker as never,
            torrentMetaStore: torrentMetaStore as never,
            runTaskMutation: runImmediately,
            runExclusivePersistence: persistImmediately,
          }
        )
      ).rejects.toMatchObject({
        code: ErrorCode.InvalidSelection,
      })

      expect(magnetTracker.cancel).not.toHaveBeenCalled()
      expect(finalNamePicker.pick).not.toHaveBeenCalled()
      expect(mkdirMock).not.toHaveBeenCalled()
      expect(torrentMetaStore.persist).not.toHaveBeenCalled()
      expect(db.saveTaskWithInstancesAndFiles).not.toHaveBeenCalled()
      expect(adapter.addTorrent).not.toHaveBeenCalled()
    }
  )

  it('serializes concurrent confirmations and rejects the queued duplicate', async () => {
    const cancelStarted = deferred()
    const releaseCancel = deferred()
    magnetTracker.cancel.mockImplementationOnce(async () => {
      cancelStarted.resolve()
      await releaseCancel.promise
      return 'removed'
    })
    const admission = createMutationAdmission()
    const deps = {
      db,
      taskManager,
      adapter: adapter as never,
      magnetTracker: magnetTracker as never as MagnetTracker,
      publishTaskUpdate: () =>
        eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
      publishTaskUpdateNow: () =>
        eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
      finalNamePicker: finalNamePicker as never,
      torrentMetaStore: torrentMetaStore as never,
      runTaskMutation: admission.runTaskMutation,
      runExclusivePersistence: persistImmediately,
    }
    const input = {
      taskId: 'm-mag',
      base64: 'BASE64TORRENT==',
      selectedFiles: [0, 1],
      saveDir: '/Downloads',
      name: 'video.mp4',
    }

    const firstSwap = swapMagnetMetadataForBt(input, deps)
    await cancelStarted.promise
    const duplicateSwap = swapMagnetMetadataForBt(input, deps)
    await vi.waitFor(() => {
      expect(
        admission.calls.length === 2 ||
          magnetTracker.cancel.mock.calls.length === 2
      ).toBe(true)
    })
    releaseCancel.resolve()

    const [first, duplicate] = await Promise.allSettled([
      firstSwap,
      duplicateSwap,
    ])
    expect(first).toMatchObject({ status: 'fulfilled' })
    expect(duplicate).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        code: ErrorCode.InvalidSelection,
      }),
    })
    if (first.status !== 'fulfilled') {
      throw first.reason
    }

    expect(admission.calls).toEqual([['m-mag'], ['m-mag']])
    expect(adapter.addTorrent).toHaveBeenCalledTimes(1)
    expect(db.getTask('m-mag')?.instances).toEqual([
      expect.objectContaining({
        gid: first.value.gid,
        phase: TaskInstancePhase.BtDownload,
      }),
    ])
    expect(taskManager.getByEngineTaskId(first.value.gid)?.id).toBe('m-mag')
  })

  it('preserves the DB task row across the swap (does not let cancel delete it)', async () => {
    // Real-world bug: MagnetTracker.cancel(taskId) unconditionally
    // sets pendingUserDelete=true, which causes its cleanup-success
    // branch to db.deleteTask(taskId). That contract belongs to
    // removeTask. swap reuses cancel only to drop the cache entry +
    // tear down the aria2 metadata GID — the persistent task row
    // must survive because the very next call writes a new
    // bt_download instance under that same motrixId. If the row is
    // gone, the atomic DB commit trips the FK constraint and the
    // entire swap throws after adapter.addTorrent has already
    // accepted a fresh BT GID, leaving aria2 with an orphan + the
    // dialog open.
    await swapMagnetMetadataForBt(
      {
        taskId: 'm-mag',
        base64: 'BASE64==',
        selectedFiles: [0],
        saveDir: '/Downloads',
      },
      {
        db,
        taskManager,
        adapter: adapter as never,
        magnetTracker: magnetTracker as never as MagnetTracker,
        publishTaskUpdate: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        publishTaskUpdateNow: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        finalNamePicker: finalNamePicker as never,
        torrentMetaStore: torrentMetaStore as never,
        runTaskMutation: runImmediately,
        runExclusivePersistence: persistImmediately,
      }
    )

    expect(db.deleteTask).not.toHaveBeenCalled()
    // And the row survives in the mock store.
    expect(db.getTask('m-mag')).not.toBeNull()
    // cancel was still called for resource cleanup — but with
    // deleteTaskRow:false so the pendingUserDelete branch is skipped.
    expect(magnetTracker.cancel).toHaveBeenCalledWith(
      'm-mag',
      expect.objectContaining({ deleteTaskRow: false })
    )
  })

  it('replaces magnet_metadata_resolution instance with bt_download instance in place', async () => {
    const result = await swapMagnetMetadataForBt(
      {
        taskId: 'm-mag',
        base64: 'BASE64TORRENT==',
        selectedFiles: [0, 1],
        saveDir: '/Downloads',
        name: 'video.mp4',
      },
      {
        db,
        taskManager,
        adapter: adapter as never,
        magnetTracker: magnetTracker as never as MagnetTracker,
        publishTaskUpdate: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        publishTaskUpdateNow: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        finalNamePicker: finalNamePicker as never,
        torrentMetaStore: torrentMetaStore as never,
        runTaskMutation: runImmediately,
        runExclusivePersistence: persistImmediately,
      }
    )

    const reservedGid = adapter.addTorrent.mock.calls[0][0].gid
    expect(reservedGid).toMatch(/^[0-9a-f]{16}$/)
    expect(result.gid).toBe(reservedGid)

    const after = db.getTask('m-mag')
    expect(after?.instances).toHaveLength(1)
    expect(after?.instances[0].phase).toBe(TaskInstancePhase.BtDownload)
    expect(after?.instances[0].gid).toBe(reservedGid)
    // Identity preserved: task name updated, createdAt unchanged.
    expect(after?.task.name).toBe('video.mp4')
    expect(after?.task.createdAt).toBe(1700000000)
    // aggStatus moves from FetchingMetadata to Downloading.
    expect(after?.task.aggStatus).toBe(TaskStatus.Downloading)
    // Selected files persisted.
    expect(db.saveTaskWithInstancesAndFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({ fileIndex: 0, selected: true }),
          expect.objectContaining({ fileIndex: 1, selected: true }),
        ]),
      })
    )
    // TaskManager mirrors the new state.
    const tmTask = (taskManager.set as ReturnType<typeof vi.fn>).mock
      .calls[0][1]
    expect(tmTask.id).toBe('m-mag')
    expect(tmTask.createdAt).toBe(1700000000)
    expect(tmTask.bt?.selectedFiles).toEqual([0, 1])
  })

  it('persists complete engine file metadata instead of index placeholders', async () => {
    adapter.getTaskFiles.mockResolvedValueOnce([
      {
        index: 0,
        path: '/Downloads/Show.motrix/episode-01.mkv',
        size: 1_500_000_000,
        completedBytes: 0,
        selected: true,
      },
      {
        index: 1,
        path: '/Downloads/Show.motrix/episode-02.mkv',
        size: 1_600_000_000,
        completedBytes: 0,
        selected: false,
      },
    ])

    const result = await swapMagnetMetadataForBt(
      {
        taskId: 'm-mag',
        base64: 'BASE64TORRENT==',
        selectedFiles: [0],
        saveDir: '/Downloads',
        name: 'Show',
      },
      {
        db,
        taskManager,
        adapter: adapter as never,
        magnetTracker: magnetTracker as never as MagnetTracker,
        publishTaskUpdate: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        publishTaskUpdateNow: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        finalNamePicker: finalNamePicker as never,
        torrentMetaStore: torrentMetaStore as never,
        runTaskMutation: runImmediately,
        runExclusivePersistence: persistImmediately,
      }
    )

    expect(adapter.getTaskFiles).toHaveBeenCalledWith(result.gid)
    expect(db.getTaskFiles('m-mag')).toEqual([
      {
        fileIndex: 0,
        path: '/Downloads/Show.motrix/episode-01.mkv',
        size: 1_500_000_000,
        selected: true,
      },
      {
        fileIndex: 1,
        path: '/Downloads/Show.motrix/episode-02.mkv',
        size: 1_600_000_000,
        selected: false,
      },
    ])
  })

  it('records MetadataReady-to-Downloading after durability and before publication', async () => {
    db.saveTaskWithInstances({
      task: {
        ...makeTaskRow('m-mag'),
        aggStatus: TaskStatus.MetadataReady,
      },
      instances: [
        {
          ...makeMetaInstance('m-mag', 'g-meta'),
          status: TaskStatus.MetadataReady,
        },
      ],
    })
    vi.mocked(db.saveTaskWithInstancesAndFiles).mockClear()
    const recordTransition = vi.fn().mockResolvedValue(undefined)

    await swapMagnetMetadataForBt(
      {
        taskId: 'm-mag',
        base64: 'BASE64TORRENT==',
        selectedFiles: [0],
        saveDir: '/Downloads',
      },
      {
        db,
        taskManager,
        adapter: adapter as never,
        magnetTracker: magnetTracker as never as MagnetTracker,
        publishTaskUpdate: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        publishTaskUpdateNow: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        finalNamePicker: finalNamePicker as never,
        torrentMetaStore: torrentMetaStore as never,
        recordTransition,
        runTaskMutation: runImmediately,
        runExclusivePersistence: persistImmediately,
      }
    )

    expect(recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'm-mag',
        previousStatus: TaskStatus.MetadataReady,
        nextStatus: TaskStatus.Downloading,
        accuracy: 'exact',
      })
    )
    expect(
      vi.mocked(db.saveTaskWithInstancesAndFiles).mock.invocationCallOrder[1]
    ).toBeLessThan(
      recordTransition.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
    expect(recordTransition.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(taskManager.set).mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY
    )
    expect(vi.mocked(taskManager.set).mock.invocationCallOrder[0]).toBeLessThan(
      magnetTracker.releaseFailedSwapCleanup.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY
    )
    expect(
      magnetTracker.releaseFailedSwapCleanup.mock.invocationCallOrder[0]
    ).toBeLessThan(
      eventBus.emit.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('keeps the new gid shielded while Activity is pending, then installs its owner before release', async () => {
    db.saveTaskWithInstances({
      task: {
        ...makeTaskRow('m-mag'),
        aggStatus: TaskStatus.MetadataReady,
      },
      instances: [
        {
          ...makeMetaInstance('m-mag', 'g-meta'),
          status: TaskStatus.MetadataReady,
        },
      ],
    })

    let releaseActivity!: () => void
    const activityBarrier = new Promise<void>((resolve) => {
      releaseActivity = resolve
    })
    const recordTransition = vi.fn(() => activityBarrier)
    const runExclusivePersistence = createPersistenceQueue()

    const swapPromise = swapMagnetMetadataForBt(
      {
        taskId: 'm-mag',
        base64: 'BASE64TORRENT==',
        selectedFiles: [0],
        saveDir: '/Downloads',
      },
      {
        db,
        taskManager,
        adapter: adapter as never,
        magnetTracker: magnetTracker as never as MagnetTracker,
        publishTaskUpdate: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        publishTaskUpdateNow: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        finalNamePicker: finalNamePicker as never,
        torrentMetaStore: torrentMetaStore as never,
        recordTransition,
        runTaskMutation: runImmediately,
        runExclusivePersistence,
      }
    )

    await vi.waitFor(() => expect(recordTransition).toHaveBeenCalledTimes(1))
    const reservedGid = adapter.addTorrent.mock.calls[0]?.[0].gid as string
    let queuedAutosaveStarted = false
    let queuedAutosaveSnapshot: DownloadTask | undefined
    const queuedAutosave = runExclusivePersistence(() => {
      queuedAutosaveStarted = true
      queuedAutosaveSnapshot = taskManager.getById('m-mag')
    })

    // Equivalent to the poll orphan-adoption seam: while Activity is blocked,
    // either MagnetTracker must shield the GID or TaskManager must own it.
    expect(magnetTracker.observe({ gid: reservedGid })).toBe(true)
    expect(taskManager.getByEngineTaskId(reservedGid)?.id).toBe('m-mag')
    expect(taskManager.isEngineTaskIdRetired(reservedGid)).toBe(true)
    expect(taskManager.set).not.toHaveBeenCalled()
    expect(magnetTracker.releaseFailedSwapCleanup).not.toHaveBeenCalled()
    // A queued SessionManager autosave must remain behind the complete
    // DB -> Activity -> TaskManager publication barrier. If it starts here,
    // it can persist the silent MetadataReady reservation over BT success.
    await Promise.resolve()
    expect(queuedAutosaveStarted).toBe(false)

    releaseActivity()
    await expect(swapPromise).resolves.toEqual({
      outcome: 'created',
      gid: reservedGid,
      taskId: 'm-mag',
    })
    await queuedAutosave

    expect(taskManager.getByEngineTaskId(reservedGid)?.id).toBe('m-mag')
    expect(taskManager.isEngineTaskIdRetired(reservedGid)).toBe(false)
    expect(magnetTracker.observe({ gid: reservedGid })).toBe(false)
    expect(queuedAutosaveSnapshot).toMatchObject({
      id: 'm-mag',
      type: TaskType.Bt,
      instances: [
        expect.objectContaining({
          gid: reservedGid,
          phase: TaskInstancePhase.BtDownload,
        }),
      ],
    })
    expect(vi.mocked(taskManager.set).mock.invocationCallOrder[0]).toBeLessThan(
      magnetTracker.releaseFailedSwapCleanup.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY
    )
  })

  it('does not record success or emit when the durable task save fails and restores the old owner', async () => {
    const saveGraph = vi.mocked(db.saveTaskWithInstancesAndFiles)
    const persistGraph = saveGraph.getMockImplementation()
    saveGraph
      .mockImplementationOnce((graph) => persistGraph?.(graph))
      .mockImplementationOnce((graph) => persistGraph?.(graph))
      .mockImplementationOnce(() => {
        throw new Error('database busy')
      })
    const recordTransition = vi.fn().mockResolvedValue(undefined)

    await expect(
      swapMagnetMetadataForBt(
        {
          taskId: 'm-mag',
          base64: 'BASE64TORRENT==',
          selectedFiles: [0],
          saveDir: '/Downloads',
        },
        {
          db,
          taskManager,
          adapter: adapter as never,
          magnetTracker: magnetTracker as never as MagnetTracker,
          publishTaskUpdate: () =>
            eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
          publishTaskUpdateNow: () =>
            eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
          finalNamePicker: finalNamePicker as never,
          torrentMetaStore: torrentMetaStore as never,
          recordTransition,
          runTaskMutation: runImmediately,
          runExclusivePersistence: persistImmediately,
        }
      )
    ).rejects.toThrow('database busy')

    expect(recordTransition).not.toHaveBeenCalled()
    expect(eventBus.emit).not.toHaveBeenCalled()
    const reservedGid = adapter.addTorrent.mock.calls[0][0].gid
    expect(taskManager.getByEngineTaskId('g-meta')?.id).toBe('m-mag')
    expect(taskManager.getByEngineTaskId(reservedGid)).toBeUndefined()
    expect(taskManager.isEngineTaskIdRetired(reservedGid)).toBe(true)
    expect(adapter.forceRemoveTask).toHaveBeenCalledWith(reservedGid)
    expect(adapter.removeDownloadResult).toHaveBeenCalledWith(reservedGid)
    expect(torrentMetaStore.remove).not.toHaveBeenCalled()
    expect(rmMock).toHaveBeenCalledWith('/Downloads/m-mag.motrix', {
      recursive: true,
      force: true,
    })
  })

  it('restores and retires when result purge proves absence after force-remove fails', async () => {
    const saveGraph = vi.mocked(db.saveTaskWithInstancesAndFiles)
    const persistGraph = saveGraph.getMockImplementation()
    saveGraph
      .mockImplementationOnce((graph) => persistGraph?.(graph))
      .mockImplementationOnce((graph) => persistGraph?.(graph))
      .mockImplementationOnce(() => {
        throw new Error('database busy')
      })
    adapter.forceRemoveTask.mockRejectedValueOnce(
      new Error('force-remove transport unavailable')
    )

    await expect(
      swapMagnetMetadataForBt(
        {
          taskId: 'm-mag',
          base64: 'BASE64TORRENT==',
          selectedFiles: [0],
          saveDir: '/Downloads',
        },
        {
          db,
          taskManager,
          adapter: adapter as never,
          magnetTracker: magnetTracker as never as MagnetTracker,
          publishTaskUpdate: () =>
            eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
          publishTaskUpdateNow: () =>
            eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
          finalNamePicker: finalNamePicker as never,
          torrentMetaStore: torrentMetaStore as never,
          runTaskMutation: runImmediately,
          runExclusivePersistence: persistImmediately,
        }
      )
    ).rejects.toThrow('database busy')

    const reservedGid = adapter.addTorrent.mock.calls[0][0].gid
    expect(adapter.removeDownloadResult).toHaveBeenCalledWith(reservedGid)
    expect(taskManager.getByEngineTaskId('g-meta')?.id).toBe('m-mag')
    expect(taskManager.getByEngineTaskId(reservedGid)).toBeUndefined()
    expect(taskManager.isEngineTaskIdRetired(reservedGid)).toBe(true)
    expect(magnetTracker.releaseFailedSwapCleanup).toHaveBeenCalledWith(
      'm-mag',
      reservedGid
    )
    expect(magnetTracker.registerFailedSwapCleanup).not.toHaveBeenCalled()
    expect(db.getTask('m-mag')).toMatchObject({
      task: {
        taskType: TaskType.Magnet,
        aggStatus: TaskStatus.MetadataReady,
      },
      instances: [
        expect.objectContaining({
          gid: 'g-meta',
          phase: TaskInstancePhase.MagnetMetadataResolution,
        }),
      ],
    })
  })

  it('isolates Activity recording failure from the durable swap result', async () => {
    const recordTransition = vi
      .fn()
      .mockRejectedValue(new Error('activity database busy'))

    await expect(
      swapMagnetMetadataForBt(
        {
          taskId: 'm-mag',
          base64: 'BASE64TORRENT==',
          selectedFiles: [0],
          saveDir: '/Downloads',
        },
        {
          db,
          taskManager,
          adapter: adapter as never,
          magnetTracker: magnetTracker as never as MagnetTracker,
          publishTaskUpdate: () =>
            eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
          publishTaskUpdateNow: () =>
            eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
          finalNamePicker: finalNamePicker as never,
          torrentMetaStore: torrentMetaStore as never,
          recordTransition,
          runTaskMutation: runImmediately,
          runExclusivePersistence: persistImmediately,
        }
      )
    ).resolves.toEqual({
      outcome: 'created',
      gid: expect.stringMatching(/^[0-9a-f]{16}$/),
      taskId: 'm-mag',
    })

    expect(taskManager.set).toHaveBeenCalled()
    expect(eventBus.emit).toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Array)
    )
  })

  it('writes into a .motrix container, persists the path trio + torrent meta, and shows type BT', async () => {
    // Mirrors createTaskHandler's BT branch. The pre-fix swap passed the bare
    // saveDir to aria2 (files loose in ~/Downloads, no in-flight container),
    // left finalPath=saveDir / finalName='' / torrentMetaPath=null — which
    // broke finalize-on-complete, broke reseed/reAdd, and let remove-with-files
    // rmdir the whole save root.
    await swapMagnetMetadataForBt(
      {
        taskId: 'm-mag',
        base64: 'BASE64==',
        selectedFiles: [0],
        saveDir: '/Downloads',
        name: 'Movie',
      },
      {
        db,
        taskManager,
        adapter: adapter as never,
        magnetTracker: magnetTracker as never as MagnetTracker,
        publishTaskUpdate: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        publishTaskUpdateNow: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        finalNamePicker: finalNamePicker as never,
        torrentMetaStore: torrentMetaStore as never,
        runTaskMutation: runImmediately,
        runExclusivePersistence: persistImmediately,
      }
    )

    // aria2's dir is the in-flight container, NOT the bare saveDir.
    expect(adapter.addTorrent).toHaveBeenCalledWith(
      expect.objectContaining({ saveDir: '/Downloads/Movie.motrix' })
    )
    // Container is pre-created so aria2's <dir>/<sha1>.torrent write succeeds.
    expect(mkdirMock).toHaveBeenCalledWith('/Downloads/Movie.motrix', {
      recursive: true,
    })

    const after = db.getTask('m-mag')
    expect(after?.instances[0].diskPath).toBe('/Downloads/Movie.motrix')
    // Path trio set so finalize renames container -> final on completion.
    expect(after?.task.finalPath).toBe('/Downloads/Movie')
    expect(after?.task.finalName).toBe('Movie')
    // torrentMetaPath persisted so reseed / reAdd don't throw meta-missing.
    expect(after?.task.torrentMetaPath).toBe('/u/torrents/m-mag.torrent')
    expect(torrentMetaStore.persist).toHaveBeenCalled()

    // Live task shows BT immediately — no MAGNET->BT flip on restart.
    const tmTask = (taskManager.set as ReturnType<typeof vi.fn>).mock.calls.at(
      -1
    )?.[1]
    expect(tmTask.type).toBe(TaskType.Bt)
  })

  it('uses indexed short staging after magnet metadata resolves', async () => {
    const torrent = buildSingleFileTorrent('very-long-original-name.iso')

    await swapMagnetMetadataForBt(
      {
        taskId: 'm-mag',
        base64: Buffer.from(torrent).toString('base64'),
        selectedFiles: [0],
        saveDir: '/Downloads',
        name: 'User friendly name.iso',
      },
      {
        db,
        taskManager,
        adapter: adapter as never,
        magnetTracker: magnetTracker as never as MagnetTracker,
        publishTaskUpdate: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        publishTaskUpdateNow: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        finalNamePicker: finalNamePicker as never,
        torrentMetaStore: torrentMetaStore as never,
        runTaskMutation: runImmediately,
        runExclusivePersistence: persistImmediately,
      }
    )

    const params = adapter.addTorrent.mock.calls[0][0]
    expect(params.saveDir).toMatch(/^\/Downloads\/\.motrix\/[a-f0-9]{20}$/)
    expect(params.outputFilePaths).toEqual([
      { fileIndex: 0, relativePath: 'p' },
    ])
    expect(
      db.getTask('m-mag')?.instances[0].payload.btStorageLayout
    ).toMatchObject({
      workspacePath: params.saveDir,
      payloadEntry: 'p',
      torrentRootName: 'very-long-original-name.iso',
    })
    expect(params.prioritizePreviewPieces).toBeUndefined()
  })

  it('enables preview piece priority after video metadata resolves', async () => {
    const torrent = buildSingleFileTorrent('Movie.mkv')

    await swapMagnetMetadataForBt(
      {
        taskId: 'm-mag',
        base64: Buffer.from(torrent).toString('base64'),
        selectedFiles: [0],
        saveDir: '/Downloads',
      },
      {
        db,
        taskManager,
        adapter: adapter as never,
        magnetTracker: magnetTracker as never as MagnetTracker,
        publishTaskUpdate: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        publishTaskUpdateNow: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        finalNamePicker: finalNamePicker as never,
        torrentMetaStore: torrentMetaStore as never,
        runTaskMutation: runImmediately,
        runExclusivePersistence: persistImmediately,
      }
    )

    expect(adapter.addTorrent).toHaveBeenCalledWith(
      expect.objectContaining({ prioritizePreviewPieces: true })
    )
  })

  it('passes 1-based file indices to adapter.addTorrent (aria2 --select-file)', async () => {
    // The dialog supplies 0-based indices from TorrentParser, but aria2's
    // --select-file uses 1-based indices. The first file is index 0 in the
    // domain model and must arrive at aria2 as `1`; passing `0` triggers
    // aria2's "We encountered a problem while processing the option
    // '--select-file'" error.
    await swapMagnetMetadataForBt(
      {
        taskId: 'm-mag',
        base64: 'BASE64==',
        selectedFiles: [0, 2, 3],
        saveDir: '/Downloads',
      },
      {
        db,
        taskManager,
        adapter: adapter as never,
        magnetTracker: magnetTracker as never as MagnetTracker,
        publishTaskUpdate: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        publishTaskUpdateNow: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        finalNamePicker: finalNamePicker as never,
        torrentMetaStore: torrentMetaStore as never,
        runTaskMutation: runImmediately,
        runExclusivePersistence: persistImmediately,
      }
    )

    expect(adapter.addTorrent).toHaveBeenCalledWith(
      expect.objectContaining({ selectedFiles: [1, 3, 4] })
    )
  })

  it('aborts with MagnetCleanupPending when MagnetTracker.cancel returns quarantined (Codex finding #12)', async () => {
    magnetTracker = createMockTracker('quarantined')

    await expect(
      swapMagnetMetadataForBt(
        {
          taskId: 'm-mag',
          base64: 'BASE64TORRENT==',
          selectedFiles: [0, 1],
          saveDir: '/Downloads',
          name: 'video.mp4',
        },
        {
          db,
          taskManager,
          adapter: adapter as never,
          magnetTracker: magnetTracker as never as MagnetTracker,
          publishTaskUpdate: () =>
            eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
          publishTaskUpdateNow: () =>
            eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
          finalNamePicker: finalNamePicker as never,
          torrentMetaStore: torrentMetaStore as never,
          runTaskMutation: runImmediately,
          runExclusivePersistence: persistImmediately,
        }
      )
    ).rejects.toThrow(AppError)

    expect(adapter.addTorrent).not.toHaveBeenCalled()

    // DB metadata instance preserved (tombstone for primeFromDatabase).
    const after = db.getTask('m-mag')
    expect(after?.instances).toHaveLength(1)
    expect(after?.instances[0].phase).toBe(
      TaskInstancePhase.MagnetMetadataResolution
    )
  })

  it('throws when existingTaskId does not match any task', async () => {
    await expect(
      swapMagnetMetadataForBt(
        {
          taskId: 'm-nonexistent',
          base64: 'BASE64TORRENT==',
          selectedFiles: [0],
          saveDir: '/Downloads',
        },
        {
          db,
          taskManager,
          adapter: adapter as never,
          magnetTracker: magnetTracker as never as MagnetTracker,
          publishTaskUpdate: () =>
            eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
          publishTaskUpdateNow: () =>
            eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
          finalNamePicker: finalNamePicker as never,
          torrentMetaStore: torrentMetaStore as never,
          runTaskMutation: runImmediately,
          runExclusivePersistence: persistImmediately,
        }
      )
    ).rejects.toMatchObject({
      code: ErrorCode.TaskNotFound,
    })

    // No engine call.
    expect(adapter.addTorrent).not.toHaveBeenCalled()
    // No cancel attempt — early abort before touching the tracker.
    expect(magnetTracker.cancel).not.toHaveBeenCalled()
  })

  it('preserves the original task createdAt across the swap', async () => {
    await swapMagnetMetadataForBt(
      {
        taskId: 'm-mag',
        base64: 'BASE64==',
        selectedFiles: [0],
        saveDir: '/Downloads',
      },
      {
        db,
        taskManager,
        adapter: adapter as never,
        magnetTracker: magnetTracker as never as MagnetTracker,
        publishTaskUpdate: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        publishTaskUpdateNow: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        finalNamePicker: finalNamePicker as never,
        torrentMetaStore: torrentMetaStore as never,
        runTaskMutation: runImmediately,
        runExclusivePersistence: persistImmediately,
      }
    )

    const saved = (
      db.saveTaskWithInstancesAndFiles as ReturnType<typeof vi.fn>
    ).mock.calls.at(-1)?.[0] as TaskWithInstances
    expect(saved.task.createdAt).toBe(1700000000)
  })

  it('emits Events.TaskUpdated so the Downloads list refreshes (Bug 1 regression)', async () => {
    await swapMagnetMetadataForBt(
      {
        taskId: 'm-mag',
        base64: 'BASE64==',
        selectedFiles: [0],
        saveDir: '/Downloads',
        name: 'video.mp4',
      },
      {
        db,
        taskManager,
        adapter: adapter as never,
        magnetTracker: magnetTracker as never as MagnetTracker,
        publishTaskUpdate: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        publishTaskUpdateNow: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        finalNamePicker: finalNamePicker as never,
        torrentMetaStore: torrentMetaStore as never,
        runTaskMutation: runImmediately,
        runExclusivePersistence: persistImmediately,
      }
    )

    const emit = eventBus.emit.mock.calls.find(
      (c: unknown[]) => c[0] === 'event:taskUpdated'
    )
    expect(emit).toBeDefined()
    expect(Array.isArray(emit?.[1])).toBe(true)
  })
})
