import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NOOP_TASK_ACTIVITY_RECORDER } from '@core/activity'
import { EventBus } from '@core/events/event-bus'
import type {
  MotrixDatabase,
  TaskFileRow,
  TaskInstanceRow,
  TaskRow,
  TaskWithInstances,
  TaskWithInstancesAndFiles,
} from '@core/session/motrix-database'
import { btWorkspacePath } from '@core/task/bt-storage-layout'
import type { OccurrenceDispatcher } from '@core/task/occurrences/occurrence-dispatcher'
import type { TaskManager } from '@core/task/task-manager'
import { DownloadErrorCode, ErrorCode } from '@shared/errors'
import { Events } from '@shared/protocol/events'
import { magnetFileSelectionPayloadSchema } from '@shared/schemas/add-task'
import type { DownloadTask } from '@shared/types/task'
import {
  makeDefaultBtExtension,
  makeDownloadTask,
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import type { TaskOccurrence } from '@shared/types/task-occurrence'
import type { TorrentMeta } from '@shared/types/torrent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withMagnetCleanupRestoreGraph } from './magnet-cleanup-quarantine'
import { MagnetTracker } from './magnet-tracker'
import type { TorrentParser } from './torrent-parser'

// ─── Mock factories ─────────────────────────────────────────────

type EventHandler = (event: { gid: string }) => void

function createMockRpcClient() {
  return {
    addUri:
      vi.fn<
        (
          uris: string[],
          options?: Record<string, string | string[]>
        ) => Promise<string>
      >(),
    tellStatus: vi.fn(),
    getFiles: vi.fn(),
    remove: vi.fn<(gid: string) => Promise<string>>(),
    forceRemove: vi.fn<(gid: string) => Promise<string>>(),
    removeDownloadResult: vi.fn<(gid: string) => Promise<'OK'>>(),
    onDownloadComplete: vi
      .fn<(handler: EventHandler) => () => void>()
      .mockReturnValue(vi.fn()),
    onBtDownloadComplete: vi
      .fn<(handler: EventHandler) => () => void>()
      .mockReturnValue(vi.fn()),
    onDownloadError: vi
      .fn<(handler: EventHandler) => () => void>()
      .mockReturnValue(vi.fn()),
  }
}

function createMockEventBus() {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    removeAll: vi.fn(),
  }
}

function createMockSettingsManager(overrides?: {
  magnetFileSelection?: boolean
  magnetResolveTimeout?: number
}) {
  return {
    getApp: vi.fn().mockReturnValue({
      magnetFileSelection: overrides?.magnetFileSelection ?? true,
    }),
    getEngine: vi.fn().mockReturnValue({
      magnetResolveTimeout: overrides?.magnetResolveTimeout ?? 120,
    }),
  }
}

function createMockMotrixDatabase(): MotrixDatabase {
  const tasksStore = new Map<string, TaskRow>()
  const instancesStore = new Map<string, TaskInstanceRow[]>()
  const filesStore = new Map<string, TaskFileRow[]>()
  return {
    init: vi.fn(),
    saveTaskWithInstances: vi.fn((pair: TaskWithInstances) => {
      tasksStore.set(pair.task.motrixId, pair.task)
      instancesStore.set(pair.task.motrixId, pair.instances)
    }),
    persistTaskWithOccurrence: vi.fn(
      (pair: TaskWithInstances, _occurrence: TaskOccurrence | null) => {
        tasksStore.set(pair.task.motrixId, pair.task)
        instancesStore.set(pair.task.motrixId, pair.instances)
      }
    ),
    saveTaskWithInstancesAndFiles: vi.fn((pair: TaskWithInstancesAndFiles) => {
      tasksStore.set(pair.task.motrixId, pair.task)
      instancesStore.set(pair.task.motrixId, pair.instances)
      filesStore.set(pair.task.motrixId, pair.files)
    }),
    getTask: vi.fn((motrixId: string) => {
      const task = tasksStore.get(motrixId)
      if (!task) return null
      return { task, instances: instancesStore.get(motrixId) ?? [] }
    }),
    getAllTasks: vi.fn(() =>
      [...tasksStore.values()].map((task) => ({
        task,
        instances: instancesStore.get(task.motrixId) ?? [],
      }))
    ),
    replaceInstances: vi.fn((motrixId: string, rows: TaskInstanceRow[]) => {
      instancesStore.set(motrixId, rows)
    }),
    deleteInstance: vi.fn((instanceId: string) => {
      for (const [motrixId, list] of instancesStore.entries()) {
        instancesStore.set(
          motrixId,
          list.filter((i) => i.instanceId !== instanceId)
        )
      }
    }),
    deleteTask: vi.fn((motrixId: string) => {
      tasksStore.delete(motrixId)
      instancesStore.delete(motrixId)
      filesStore.delete(motrixId)
    }),
    replaceTaskFiles: vi.fn((motrixId: string, rows: TaskFileRow[]) => {
      filesStore.set(motrixId, rows)
    }),
    getTaskFiles: vi.fn((motrixId: string) => filesStore.get(motrixId) ?? []),
  } as unknown as MotrixDatabase
}

function createMockTorrentParser(): TorrentParser & {
  parse: ReturnType<typeof vi.fn>
} {
  const parser = {
    parse: vi.fn(async (_base64: string): Promise<TorrentMeta> => {
      // Default — tests that care about meta override per-test.
      return {
        name: 'mock-torrent',
        infoHash: 'a'.repeat(40),
        totalSize: 0,
        files: [
          {
            index: 0,
            path: 'mock-torrent/placeholder',
            size: 0,
            extension: '',
          },
        ],
        comment: null,
        isPrivate: false,
      }
    }),
  }
  return parser as unknown as TorrentParser & {
    parse: ReturnType<typeof vi.fn>
  }
}

function createMockTaskManager(): TaskManager {
  const tasks = new Map<string, DownloadTask>()
  const reservations = new Set<string>()
  const retired = new Set<string>()
  const taskGids = (task: DownloadTask): string[] => [
    ...task.instances.flatMap((instance) =>
      instance.gid ? [instance.gid] : []
    ),
    ...(task.engineTaskId ? [task.engineTaskId] : []),
  ]
  const store = (id: string, task: DownloadTask, claim: boolean): void => {
    tasks.set(id, task)
    if (claim) {
      for (const gid of taskGids(task)) reservations.delete(gid)
    }
  }
  return {
    set: vi.fn((id: string, task: DownloadTask) => store(id, task, true)),
    add: vi.fn((task: DownloadTask) => store(task.id, task, true)),
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
    getById: vi.fn((id: string) => tasks.get(id)),
    getByEngineTaskId: vi.fn((gid: string) => {
      for (const task of tasks.values()) {
        if (task.instances.some((i) => i.gid === gid)) return task
      }
      return undefined
    }),
    remove: vi.fn((id: string) => {
      const task = tasks.get(id)
      if (task) {
        for (const gid of taskGids(task)) retired.add(gid)
      }
      return tasks.delete(id)
    }),
    getAll: vi.fn(() => [...tasks.values()]),
    clear: vi.fn(() => tasks.clear()),
  } as unknown as TaskManager
}

function createMagnetTracker(
  rpcClient: ReturnType<typeof createMockRpcClient>,
  eventBus: EventBus | ReturnType<typeof createMockEventBus>,
  settingsManager: ReturnType<typeof createMockSettingsManager>,
  db: MotrixDatabase,
  taskManager: TaskManager,
  torrentParser: TorrentParser,
  activityRecorder = NOOP_TASK_ACTIVITY_RECORDER,
  lifecycle?: {
    parentTaskCreated?: (
      task: DownloadTask,
      persistParent: () => void | Promise<void>
    ) => Promise<void>
    recordTransition?: (input: {
      taskId: string
      previousStatus: TaskStatus
      nextStatus: TaskStatus
      occurredAt: number
      monotonicAt: number
      accuracy: 'exact' | 'recovered'
      errorCode: DownloadTask['errorCode']
      errorMessage: string | null
    }) => void | Promise<void>
    deleteParentTask?: (
      taskId: string,
      deleteParent: () => void | Promise<void>
    ) => Promise<void>
    runTaskMutation?: <T>(
      taskIds: readonly string[],
      operation: () => Promise<T>
    ) => Promise<T>
    runExclusivePersistence?: <T>(operation: () => T | Promise<T>) => Promise<T>
    torrentMetaDir?: string
    occurrenceDispatcher?: Pick<OccurrenceDispatcher, 'dispatch'>
  }
): MagnetTracker {
  return new MagnetTracker(
    rpcClient as never,
    eventBus as never,
    settingsManager as never,
    db,
    taskManager,
    torrentParser,
    activityRecorder,
    {
      // Pass-throughs keep the legacy eventBus.emit assertions valid.
      publishTaskUpdate: () =>
        (eventBus as EventBus).emit(Events.TaskUpdated, taskManager.getAll()),
      publishTaskUpdateNow: () =>
        (eventBus as EventBus).emit(Events.TaskUpdated, taskManager.getAll()),
      ...lifecycle,
    }
  )
}

// ─── Tests ──────────────────────────────────────────────────────

describe('MagnetTracker', () => {
  let rpc: ReturnType<typeof createMockRpcClient>
  let eventBus: ReturnType<typeof createMockEventBus>
  let settings: ReturnType<typeof createMockSettingsManager>
  let db: MotrixDatabase
  let taskManager: TaskManager
  let torrentParser: ReturnType<typeof createMockTorrentParser>
  let tmpDirs: string[]

  beforeEach(() => {
    vi.useFakeTimers()
    rpc = createMockRpcClient()
    eventBus = createMockEventBus()
    settings = createMockSettingsManager()
    db = createMockMotrixDatabase()
    taskManager = createMockTaskManager()
    torrentParser = createMockTorrentParser()
    rpc.addUri.mockImplementation(async (_uris, options) => {
      const gid = options?.gid
      return typeof gid === 'string' ? gid : 'gid-abc'
    })
    rpc.remove.mockResolvedValue('OK')
    rpc.forceRemove.mockResolvedValue('OK')
    rpc.removeDownloadResult.mockResolvedValue('OK')
    tmpDirs = []
  })

  afterEach(async () => {
    vi.useRealTimers()
    for (const dir of tmpDirs) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'motrix-magnet-'))
    tmpDirs.push(dir)
    return dir
  }

  function lastMetadataDir(): string {
    const options = rpc.addUri.mock.calls.at(-1)?.[1]
    const dir = options?.dir
    expect(typeof dir).toBe('string')
    if (!tmpDirs.includes(dir as string)) {
      tmpDirs.push(dir as string)
    }
    return dir as string
  }

  function lastMetadataGid(): string {
    const gid = rpc.addUri.mock.calls.at(-1)?.[1]?.gid
    expect(gid).toMatch(/^[a-f0-9]{16}$/)
    return gid as string
  }

  async function writeTorrentFixture(
    metadataDir: string,
    bytes = Buffer.from('torrent-bytes')
  ): Promise<{ base64: string }> {
    await writeFile(
      path.join(metadataDir, 'aria2-saved-metadata.torrent'),
      bytes
    )
    return { base64: bytes.toString('base64') }
  }

  // ── 1. Constructor registers handlers ─────────────────────────

  it('registers completion and error handlers', () => {
    createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    expect(rpc.onDownloadComplete).toHaveBeenCalledOnce()
    expect(rpc.onBtDownloadComplete).toHaveBeenCalledOnce()
    expect(rpc.onDownloadError).toHaveBeenCalledOnce()
    expect(typeof rpc.onDownloadComplete.mock.calls[0][0]).toBe('function')
    expect(typeof rpc.onBtDownloadComplete.mock.calls[0][0]).toBe('function')
    expect(typeof rpc.onDownloadError.mock.calls[0][0]).toBe('function')
  })

  // ── 2. submit with magnetFileSelection ON ─────────────────────

  it('starts metadata-only fetch when magnetFileSelection is ON', async () => {
    const dir = await makeTempDir()
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    await tracker.submit('magnet:?xt=urn:btih:abc123', dir)

    const metadataDir = lastMetadataDir()
    expect(metadataDir).not.toBe(dir)
    expect(rpc.addUri).toHaveBeenCalledWith(['magnet:?xt=urn:btih:abc123'], {
      'bt-load-saved-metadata': 'false',
      'bt-metadata-only': 'true',
      dir: metadataDir,
      'follow-torrent': 'false',
      gid: expect.stringMatching(/^[a-f0-9]{16}$/),
    })
  })

  it('reuses a same-directory seed and rejects a second active directory', async () => {
    const dir = await makeTempDir()
    const infoHash = 'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc'
    const existing = makeDownloadTask({
      id: 'existing-seed',
      engineTaskId: 'existing-gid',
      name: 'sample-data',
      kind: TaskKind.Bt,
      type: TaskType.Bt,
      status: TaskStatus.Seeding,
      saveDir: dir,
      createdAt: 1,
      updatedAt: 1,
      filename: 'sample-data',
      diskPath: path.join(dir, 'sample-data'),
      finalPath: path.join(dir, 'sample-data'),
      finalName: 'sample-data',
      infoHash,
      bt: makeDefaultBtExtension({ selectedFiles: [0] }),
      source: 'user',
      sourceMeta: null,
      instances: [
        {
          instanceId: 'primary:existing-seed',
          motrixId: 'existing-seed',
          gid: 'existing-gid',
          phase: TaskInstancePhase.BtDownload,
          status: TaskStatus.Seeding,
          progress: 1,
          totalBytes: 1024,
          downloadedBytes: 1024,
          uploadedBytes: 0,
          diskPath: path.join(dir, 'sample-data'),
          transitionPhase: TransitionPhase.Idle,
          uris: [],
          uriHash: null,
          payload: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
    taskManager.set(existing.id, existing)
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    await expect(
      tracker.submit(`magnet:?xt=urn:btih:${infoHash}`, dir)
    ).resolves.toBe(existing.id)
    expect(rpc.addUri).not.toHaveBeenCalled()

    const otherDir = await makeTempDir()
    await expect(
      tracker.submit(`magnet:?xt=urn:btih:${infoHash}`, otherDir)
    ).rejects.toMatchObject({
      conflict: {
        reason: 'active-info-hash',
        existingTaskId: existing.id,
        canCreateCopy: false,
      },
    })
    expect(rpc.addUri).not.toHaveBeenCalled()
  })

  it('reserves and silently owns the caller GID before aria2 can expose it', async () => {
    const dir = await makeTempDir()
    let resolveAdd!: (gid: string) => void
    let markAddStarted!: () => void
    let requestedGid = ''
    const addStarted = new Promise<void>((resolve) => {
      markAddStarted = resolve
    })
    rpc.addUri.mockImplementation(async (_uris, options) => {
      requestedGid = options?.gid as string
      markAddStarted()
      return new Promise<string>((resolve) => {
        resolveAdd = resolve
      })
    })
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    const submitting = tracker.submit(
      'magnet:?xt=urn:btih:reserved-before-add',
      dir
    )
    await addStarted

    expect(requestedGid).toMatch(/^[a-f0-9]{16}$/)
    expect(taskManager.isEngineTaskIdRetired(requestedGid)).toBe(true)
    const silentOwner = taskManager.getByEngineTaskId(requestedGid)
    expect(silentOwner?.status).toBe(TaskStatus.FetchingMetadata)
    expect(db.getTask(silentOwner?.id ?? '')).not.toBeNull()
    expect(taskManager.set).not.toHaveBeenCalled()

    resolveAdd(requestedGid)
    const taskId = await submitting

    expect(taskId).toBe(silentOwner?.id)
    expect(taskManager.getByEngineTaskId(requestedGid)?.id).toBe(taskId)
    expect(taskManager.isEngineTaskIdRetired(requestedGid)).toBe(false)
  })

  it('records a metadata task submission after both stores and before TaskUpdated', async () => {
    const dir = await makeTempDir()
    const activityRecorder = {
      recordSubmitted: vi.fn(),
      recordDownloadCompleted: vi.fn(),
    }
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser,
      activityRecorder
    )

    const taskId = await tracker.submit('magnet:?xt=urn:btih:activity', dir)

    const task = taskManager.getById(taskId)
    const save = db.saveTaskWithInstances as ReturnType<typeof vi.fn>
    const set = taskManager.set as ReturnType<typeof vi.fn>
    expect(activityRecorder.recordSubmitted).toHaveBeenCalledWith({
      taskId,
      occurredAt: task?.createdAt,
    })
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      set.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
    expect(set.mock.invocationCallOrder[0]).toBeLessThan(
      activityRecorder.recordSubmitted.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY
    )
    expect(
      activityRecorder.recordSubmitted.mock.invocationCallOrder[0]
    ).toBeLessThan(
      eventBus.emit.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('crosses the parent durability barrier before publishing FetchingMetadata', async () => {
    const dir = await makeTempDir()
    const order: string[] = []
    const lifecycle = {
      parentTaskCreated: vi.fn(
        async (
          task: DownloadTask,
          persistParent: () => void | Promise<void>
        ) => {
          order.push(`barrier:${task.status}`)
          expect(db.getTask(task.id)).toBeNull()
          await persistParent()
          order.push('durable')
        }
      ),
    }
    vi.mocked(taskManager.set).mockImplementation((id, task) => {
      order.push('published')
      return Map.prototype.set.call(new Map(), id, task)
    })
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser,
      NOOP_TASK_ACTIVITY_RECORDER,
      lifecycle
    )

    await tracker.submit('magnet:?xt=urn:btih:durable-parent', dir)

    expect(lifecycle.parentTaskCreated).toHaveBeenCalledOnce()
    expect(order).toEqual([
      `barrier:${TaskStatus.FetchingMetadata}`,
      'durable',
      'published',
    ])
  })

  it('does not persist, publish, or emit when the parent durability barrier fails', async () => {
    const dir = await makeTempDir()
    const lifecycle = {
      parentTaskCreated: vi.fn(async () => {
        throw new Error('parent persistence failed')
      }),
    }
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser,
      NOOP_TASK_ACTIVITY_RECORDER,
      lifecycle
    )

    await expect(
      tracker.submit('magnet:?xt=urn:btih:parent-failure', dir)
    ).rejects.toThrow('parent persistence failed')

    const reservedGid = vi.mocked(taskManager.reserveEngineTaskId).mock
      .calls[0]?.[0]
    expect(db.saveTaskWithInstances).not.toHaveBeenCalled()
    expect(rpc.addUri).not.toHaveBeenCalled()
    expect(taskManager.set).not.toHaveBeenCalled()
    expect(taskManager.setReservedEngineTaskOwner).not.toHaveBeenCalled()
    expect(taskManager.rollbackReservedEngineTaskOwner).not.toHaveBeenCalled()
    expect(taskManager.releaseEngineTaskIdReservation).toHaveBeenCalledWith(
      reservedGid
    )
    expect(taskManager.isEngineTaskIdRetired(reservedGid ?? '')).toBe(false)
    expect(eventBus.emit).not.toHaveBeenCalled()
  })

  it('retires the caller GID after post-dispatch compensation so a stale poll stays blocked', async () => {
    const dir = await makeTempDir()
    rpc.addUri.mockRejectedValueOnce(new Error('rpc response lost'))
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    await expect(
      tracker.submit('magnet:?xt=urn:btih:add-response-lost', dir)
    ).rejects.toThrow('rpc response lost')

    const requestedGid = rpc.addUri.mock.calls[0]?.[1]?.gid as string
    const submittedOwner = vi.mocked(taskManager.setReservedEngineTaskOwner)
      .mock.calls[0]?.[1]
    expect(rpc.forceRemove).toHaveBeenCalledWith(requestedGid)
    expect(rpc.removeDownloadResult).toHaveBeenCalledWith(requestedGid)
    expect(db.getTask(submittedOwner?.id ?? '')).toBeNull()
    expect(taskManager.getByEngineTaskId(requestedGid)).toBeUndefined()
    expect(taskManager.retireEngineTaskIdReservation).toHaveBeenCalledWith(
      requestedGid
    )
    // Models an authoritative poll snapshot captured before forceRemove:
    // even after cache/DB cleanup it still sees a bounded negative owner.
    expect(taskManager.isEngineTaskIdRetired(requestedGid)).toBe(true)
    await expect(
      access(submittedOwner?.instances[0]?.diskPath ?? '')
    ).rejects.toThrow()
  })

  it('does not emit an occurrence for the hidden cleanup tombstone written after post-dispatch compensation', async () => {
    const dir = await makeTempDir()
    rpc.addUri.mockRejectedValueOnce(new Error('rpc response lost'))
    const dispatch = vi.fn(async () => {})
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser,
      undefined,
      { occurrenceDispatcher: { dispatch } }
    )

    await expect(
      tracker.submit('magnet:?xt=urn:btih:hidden-tombstone-occurrence', dir)
    ).rejects.toThrow('rpc response lost')

    expect(dispatch).not.toHaveBeenCalled()
    const occurrenceCalls = vi.mocked(db.persistTaskWithOccurrence).mock.calls
    expect(occurrenceCalls.length).toBeGreaterThan(0)
    for (const [, occurrence] of occurrenceCalls) {
      expect(occurrence).toBeNull()
    }
  })

  it('records MetadataReady only after its durable save and before publication', async () => {
    const saveDir = await makeTempDir()
    const lifecycle = {
      recordTransition: vi.fn().mockResolvedValue(undefined),
    }
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser,
      NOOP_TASK_ACTIVITY_RECORDER,
      lifecycle
    )
    const onComplete = rpc.onDownloadComplete.mock.calls[0][0]
    const taskId = await tracker.submit(
      `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
      saveDir
    )
    const gid = lastMetadataGid()
    await writeTorrentFixture(lastMetadataDir())
    vi.mocked(db.saveTaskWithInstances).mockClear()
    vi.mocked(taskManager.set).mockClear()

    await onComplete({ gid })

    expect(lifecycle.recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        previousStatus: TaskStatus.FetchingMetadata,
        nextStatus: TaskStatus.MetadataReady,
        accuracy: 'exact',
      })
    )
    expect(
      vi.mocked(db.saveTaskWithInstances).mock.invocationCallOrder[0]
    ).toBeLessThan(
      lifecycle.recordTransition.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY
    )
    expect(lifecycle.recordTransition.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(taskManager.set).mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY
    )
  })

  it('records Failed with error detail only after its durable save', async () => {
    const saveDir = await makeTempDir()
    const lifecycle = {
      recordTransition: vi.fn().mockResolvedValue(undefined),
    }
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser,
      NOOP_TASK_ACTIVITY_RECORDER,
      lifecycle
    )
    const onError = rpc.onDownloadError.mock.calls[0][0]
    const taskId = await tracker.submit(
      'magnet:?xt=urn:btih:metadata-error',
      saveDir
    )
    const gid = lastMetadataGid()
    vi.mocked(db.persistTaskWithOccurrence).mockClear()
    vi.mocked(taskManager.set).mockClear()

    await onError({ gid })

    expect(lifecycle.recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        previousStatus: TaskStatus.FetchingMetadata,
        nextStatus: TaskStatus.Error,
        accuracy: 'exact',
        errorCode: DownloadErrorCode.BtMetadataFailed,
        errorMessage: 'Magnet metadata fetch failed',
      })
    )
    expect(
      vi.mocked(db.persistTaskWithOccurrence).mock.invocationCallOrder[0]
    ).toBeLessThan(
      lifecycle.recordTransition.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY
    )
    expect(lifecycle.recordTransition.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(taskManager.set).mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY
    )
  })

  it('ignores a completion callback captured while a committed BT swap owns the task lock', async () => {
    const saveDir = await makeTempDir()
    let mutationTail: Promise<unknown> = Promise.resolve()
    const runTaskMutation = <T>(
      _taskIds: readonly string[],
      operation: () => Promise<T>
    ): Promise<T> => {
      const result = mutationTail.then(operation)
      mutationTail = result.then(
        () => undefined,
        () => undefined
      )
      return result
    }
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser,
      NOOP_TASK_ACTIVITY_RECORDER,
      { runTaskMutation }
    )
    const taskId = await tracker.submit(
      'magnet:?xt=urn:btih:callback-after-swap',
      saveDir
    )
    const gid = lastMetadataGid()
    await writeTorrentFixture(lastMetadataDir())
    const metadataOwner = taskManager.getById(taskId)
    const metadataPair = db.getTask(taskId)
    if (!metadataOwner || !metadataPair) {
      throw new Error('metadata fixture missing')
    }

    let releaseSwap!: () => void
    let markSwapStarted!: () => void
    const swapGate = new Promise<void>((resolve) => {
      releaseSwap = resolve
    })
    const swapStarted = new Promise<void>((resolve) => {
      markSwapStarted = resolve
    })
    const swapping = runTaskMutation([taskId], async () => {
      markSwapStarted()
      await swapGate
      const now = Date.now()
      const btTask: TaskRow = {
        ...metadataPair.task,
        taskType: TaskType.Bt,
        aggStatus: TaskStatus.Downloading,
        updatedAt: now,
      }
      const btInstance: TaskInstanceRow = {
        ...metadataPair.instances[0],
        instanceId: `bt:${taskId}`,
        gid: 'bt-committed-gid',
        phase: TaskInstancePhase.BtDownload,
        status: TaskStatus.Downloading,
        updatedAt: now,
      }
      db.saveTaskWithInstances({ task: btTask, instances: [btInstance] })
      taskManager.set(taskId, {
        ...metadataOwner,
        type: TaskType.Bt,
        status: TaskStatus.Downloading,
        engineTaskId: 'bt-committed-gid',
        instances: [btInstance],
      })
    })
    await swapStarted
    vi.mocked(torrentParser.parse).mockClear()
    vi.mocked(rpc.removeDownloadResult).mockClear()
    eventBus.emit.mockClear()

    const onComplete = rpc.onDownloadComplete.mock.calls[0][0]
    onComplete({ gid })
    await Promise.resolve()
    releaseSwap()
    await swapping
    await mutationTail

    expect(db.getTask(taskId)?.task.taskType).toBe(TaskType.Bt)
    expect(db.getTask(taskId)?.task.aggStatus).toBe(TaskStatus.Downloading)
    expect(taskManager.getById(taskId)?.engineTaskId).toBe('bt-committed-gid')
    expect(torrentParser.parse).not.toHaveBeenCalled()
    expect(rpc.removeDownloadResult).not.toHaveBeenCalled()
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      Events.MagnetFileSelection,
      expect.anything()
    )
  })

  it('ignores a stale metadata error after the graph has become a BT download', async () => {
    const saveDir = await makeTempDir()
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    const taskId = await tracker.submit(
      'magnet:?xt=urn:btih:stale-error-after-swap',
      saveDir
    )
    const gid = lastMetadataGid()
    const metadataOwner = taskManager.getById(taskId)
    const metadataPair = db.getTask(taskId)
    if (!metadataOwner || !metadataPair) {
      throw new Error('metadata fixture missing')
    }
    const btTask: TaskRow = {
      ...metadataPair.task,
      taskType: TaskType.Bt,
      aggStatus: TaskStatus.Downloading,
    }
    const btInstance: TaskInstanceRow = {
      ...metadataPair.instances[0],
      instanceId: `bt:${taskId}`,
      gid: 'bt-after-error-gid',
      phase: TaskInstancePhase.BtDownload,
      status: TaskStatus.Downloading,
    }
    db.saveTaskWithInstances({ task: btTask, instances: [btInstance] })
    taskManager.set(taskId, {
      ...metadataOwner,
      type: TaskType.Bt,
      status: TaskStatus.Downloading,
      engineTaskId: 'bt-after-error-gid',
      instances: [btInstance],
    })
    vi.mocked(rpc.forceRemove).mockClear()
    eventBus.emit.mockClear()

    const onError = rpc.onDownloadError.mock.calls[0][0]
    await onError({ gid })

    expect(db.getTask(taskId)?.task.aggStatus).toBe(TaskStatus.Downloading)
    expect(taskManager.getById(taskId)?.status).toBe(TaskStatus.Downloading)
    expect(rpc.forceRemove).not.toHaveBeenCalled()
    expect(eventBus.emit).not.toHaveBeenCalled()
  })

  it('deduplicates repeated completion notifications after MetadataReady', async () => {
    const saveDir = await makeTempDir()
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    await tracker.submit('magnet:?xt=urn:btih:duplicate-complete', saveDir)
    const gid = lastMetadataGid()
    await writeTorrentFixture(lastMetadataDir())
    eventBus.emit.mockClear()

    const onComplete = rpc.onDownloadComplete.mock.calls[0][0]
    await onComplete({ gid })
    await onComplete({ gid })

    const selectionEvents = eventBus.emit.mock.calls.filter(
      ([event]) => event === Events.MagnetFileSelection
    )
    expect(selectionEvents).toHaveLength(1)
    expect(torrentParser.parse).toHaveBeenCalledOnce()
  })

  it('serializes MetadataReady behind an older autosave so the stale snapshot cannot win', async () => {
    const saveDir = await makeTempDir()
    let persistenceTail: Promise<unknown> = Promise.resolve()
    const runExclusivePersistence = <T>(
      operation: () => T | Promise<T>
    ): Promise<T> => {
      const result = persistenceTail.then(operation)
      persistenceTail = result.then(
        () => undefined,
        () => undefined
      )
      return result
    }
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser,
      NOOP_TASK_ACTIVITY_RECORDER,
      { runExclusivePersistence }
    )
    const taskId = await tracker.submit(
      'magnet:?xt=urn:btih:queued-autosave',
      saveDir
    )
    const gid = lastMetadataGid()
    const stalePair = db.getTask(taskId)
    if (!stalePair) throw new Error('metadata fixture missing')
    await writeTorrentFixture(lastMetadataDir())

    let releaseAutosave!: () => void
    let markAutosaveStarted!: () => void
    const autosaveGate = new Promise<void>((resolve) => {
      releaseAutosave = resolve
    })
    const autosaveStarted = new Promise<void>((resolve) => {
      markAutosaveStarted = resolve
    })
    const staleAutosave = runExclusivePersistence(async () => {
      markAutosaveStarted()
      await autosaveGate
      db.saveTaskWithInstances(stalePair)
    })
    await autosaveStarted

    const onComplete = rpc.onDownloadComplete.mock.calls[0][0]
    const completion = onComplete({ gid }) as unknown as Promise<void>
    await Promise.resolve()
    releaseAutosave()
    await staleAutosave
    await completion

    expect(db.getTask(taskId)?.task.aggStatus).toBe(TaskStatus.MetadataReady)
    expect(taskManager.getById(taskId)?.status).toBe(TaskStatus.MetadataReady)
  })

  // ── 2b. submit provenance (bridge attribution) ────────────────

  it('persists bridge provenance on the metadata task when provided', async () => {
    // A magnet submitted via the browser bridge must keep source='bridge'
    // through the metadata fetch, or ProgressPublisher (source!=='bridge'
    // guard) silently drops every progress/completed/error notification back
    // to the extension. The swap-in-place later preserves whatever the row
    // carries, so attribution only has to be set here.
    const dir = await makeTempDir()
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    const sourceMeta = {
      kind: 'magnet' as const,
      extensionId: 'e',
      browser: 'chromium' as const,
      sessionKey: 'chromium:e',
      pageUrl: 'https://example.com/p',
      pageTitle: 'demo',
      qualityLabel: 'file',
      durationSec: null,
      submittedAt: 1,
    }

    const taskId = await tracker.submit('magnet:?xt=urn:btih:abc123', dir, {
      source: 'bridge',
      sourceMeta,
    })

    const pair = db.getTask(taskId)
    expect(pair?.task.source).toBe('bridge')
    expect(pair?.task.sourceMeta).toEqual(sourceMeta)
  })

  it('defaults the metadata task source to user when no provenance is given', async () => {
    const dir = await makeTempDir()
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    const taskId = await tracker.submit('magnet:?xt=urn:btih:abc123', dir)

    const pair = db.getTask(taskId)
    expect(pair?.task.source).toBe('user')
    expect(pair?.task.sourceMeta).toBeNull()
  })

  // ── 3. submit with magnetFileSelection OFF ────────────────────

  it('starts direct download when magnetFileSelection is OFF', async () => {
    settings = createMockSettingsManager({ magnetFileSelection: false })
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    await tracker.submit('magnet:?xt=urn:btih:abc123', '/downloads')

    expect(rpc.addUri).toHaveBeenCalledWith(['magnet:?xt=urn:btih:abc123'], {
      dir: '/downloads',
    })
  })

  // ── 4. onComplete for known gid ──────────────────────────────

  it('resolves metadata and emits MagnetFileSelection on complete', async () => {
    const infoHash = 'a'.repeat(40)
    const saveDir = await makeTempDir()
    // Plan B follow-up: meta comes from parsing the saved .torrent file
    // (not from aria2 raw.files, which only reports the single .torrent
    // file aria2 was downloading during bt-metadata-only=true). Inject
    // the parser's output so we exercise the new code path.
    torrentParser.parse.mockResolvedValue({
      name: 'my-torrent',
      infoHash,
      totalSize: 1048576 + 2048,
      files: [
        {
          index: 0,
          path: 'my-torrent/movie.mkv',
          size: 1048576,
          extension: '.mkv',
        },
        {
          index: 1,
          path: 'my-torrent/readme.txt',
          size: 2048,
          extension: '.txt',
        },
      ],
      comment: null,
      isPrivate: false,
    })

    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    const onComplete = rpc.onDownloadComplete.mock.calls[0][0]

    await tracker.submit(`magnet:?xt=urn:btih:${infoHash}`, saveDir)
    const gid = lastMetadataGid()
    const torrent = await writeTorrentFixture(lastMetadataDir())

    // Simulate aria2 completing metadata download
    await onComplete({ gid })

    // Parser was called with the saved .torrent file's base64.
    expect(torrentParser.parse).toHaveBeenCalledWith(torrent.base64)
    expect(rpc.removeDownloadResult).toHaveBeenCalledWith(gid)

    // Find the MagnetFileSelection emit (TaskUpdated may interleave).
    const emitCall = (
      eventBus.emit as ReturnType<typeof vi.fn>
    ).mock.calls.find((c) => c[0] === Events.MagnetFileSelection)
    expect(emitCall).toBeDefined()
    expect(emitCall?.[1]).toMatchObject({
      magnetUri: `magnet:?xt=urn:btih:${infoHash}`,
      saveDir,
      torrentBase64: torrent.base64,
      meta: {
        name: 'my-torrent',
        infoHash,
        totalSize: 1048576 + 2048,
        files: expect.arrayContaining([
          expect.objectContaining({
            index: 0,
            path: 'my-torrent/movie.mkv',
            size: 1048576,
            extension: '.mkv',
          }),
          expect.objectContaining({
            index: 1,
            path: 'my-torrent/readme.txt',
            size: 2048,
            extension: '.txt',
          }),
        ]),
      },
    })

    expect(
      magnetFileSelectionPayloadSchema.safeParse(emitCall?.[1]).success
    ).toBe(true)
  })

  it('resolves metadata when aria2 emits onBtDownloadComplete', async () => {
    const infoHash = 'b'.repeat(40)
    const saveDir = await makeTempDir()
    torrentParser.parse.mockResolvedValue({
      name: 'bt-root',
      infoHash,
      totalSize: 4096,
      files: [
        {
          index: 0,
          path: 'bt-root/file.bin',
          size: 4096,
          extension: '.bin',
        },
      ],
      comment: null,
      isPrivate: false,
    })

    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    const onBtComplete = rpc.onBtDownloadComplete.mock.calls[0][0]

    await tracker.submit(`magnet:?xt=urn:btih:${infoHash}`, saveDir)
    const gid = lastMetadataGid()
    const torrent = await writeTorrentFixture(lastMetadataDir())
    await onBtComplete({ gid })

    expect(eventBus.emit).toHaveBeenCalledWith(
      Events.MagnetFileSelection,
      expect.objectContaining({
        magnetUri: `magnet:?xt=urn:btih:${infoHash}`,
        torrentBase64: torrent.base64,
        meta: expect.objectContaining({
          infoHash,
          name: 'bt-root',
        }),
      })
    )
  })

  // ── reopenFileSelection (re-open dialog after dismiss) ────────

  it('reopenFileSelection re-emits MagnetFileSelection for a MetadataReady task', async () => {
    const infoHash = 'd'.repeat(40)
    const saveDir = await makeTempDir()
    torrentParser.parse.mockResolvedValue({
      name: 'reopen-torrent',
      infoHash,
      totalSize: 1024,
      files: [
        {
          index: 0,
          path: 'reopen-torrent/a.bin',
          size: 1024,
          extension: '.bin',
        },
      ],
      comment: null,
      isPrivate: false,
    })
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    const onComplete = rpc.onDownloadComplete.mock.calls[0][0]
    const taskId = await tracker.submit(
      `magnet:?xt=urn:btih:${infoHash}`,
      saveDir
    )
    const gid = lastMetadataGid()
    const torrent = await writeTorrentFixture(lastMetadataDir())
    await onComplete({ gid })

    // User dismissed the dialog — clear emits so we assert the RE-open emits.
    ;(eventBus.emit as ReturnType<typeof vi.fn>).mockClear()

    await tracker.reopenFileSelection(taskId)

    const emitCall = (
      eventBus.emit as ReturnType<typeof vi.fn>
    ).mock.calls.find((c) => c[0] === Events.MagnetFileSelection)
    expect(emitCall).toBeDefined()
    expect(emitCall?.[1]).toMatchObject({
      taskId,
      magnetUri: `magnet:?xt=urn:btih:${infoHash}`,
      saveDir,
      torrentBase64: torrent.base64,
    })
    expect(
      magnetFileSelectionPayloadSchema.safeParse(emitCall?.[1]).success
    ).toBe(true)
  })

  it('reopenFileSelection is a no-op when the task is not MetadataReady', async () => {
    const infoHash = 'e'.repeat(40)
    const saveDir = await makeTempDir()
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    const taskId = await tracker.submit(
      `magnet:?xt=urn:btih:${infoHash}`,
      saveDir
    )
    // Still FetchingMetadata (no onComplete fired).
    ;(eventBus.emit as ReturnType<typeof vi.fn>).mockClear()

    await tracker.reopenFileSelection(taskId)

    const emitCall = (
      eventBus.emit as ReturnType<typeof vi.fn>
    ).mock.calls.find((c) => c[0] === Events.MagnetFileSelection)
    expect(emitCall).toBeUndefined()
  })

  it('reopenFileSelection throws MagnetResolveFailed when the saved .torrent is gone', async () => {
    const infoHash = 'f'.repeat(40)
    const saveDir = await makeTempDir()
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    const onComplete = rpc.onDownloadComplete.mock.calls[0][0]
    const taskId = await tracker.submit(
      `magnet:?xt=urn:btih:${infoHash}`,
      saveDir
    )
    const gid = lastMetadataGid()
    const metaDir = lastMetadataDir()
    await writeTorrentFixture(metaDir)
    await onComplete({ gid })
    // Temp dir cleared (e.g. OS reboot wiped /tmp).
    await rm(metaDir, { recursive: true, force: true })

    await expect(tracker.reopenFileSelection(taskId)).rejects.toMatchObject({
      code: ErrorCode.MagnetResolveFailed,
    })
  })

  it('feeds the saved .torrent base64 to TorrentParser, ignoring aria2 raw.files (Bug 2 regression)', async () => {
    // Real-world bug: aria2's tellStatus.files for a bt-metadata-only
    // task reports the single .torrent file being fetched, not the
    // torrent's contained files. Reading raw.files emits a 1-file meta
    // even when the actual torrent has many files. Fix: parse the
    // saved .torrent base64 instead of trusting raw.files.
    const infoHash = 'c'.repeat(40)
    const saveDir = await makeTempDir()
    torrentParser.parse.mockResolvedValue({
      name: 'multi-file-torrent',
      infoHash,
      totalSize: 4096 + 2048 + 51200,
      files: [
        { index: 0, path: 'multi/video.mkv', size: 4096, extension: '.mkv' },
        { index: 1, path: 'multi/readme.txt', size: 2048, extension: '.txt' },
        { index: 2, path: 'multi/cover.jpg', size: 51200, extension: '.jpg' },
      ],
      comment: null,
      isPrivate: false,
    })

    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    const onBtComplete = rpc.onBtDownloadComplete.mock.calls[0][0]

    await tracker.submit(`magnet:?xt=urn:btih:${infoHash}`, saveDir)
    const gid = lastMetadataGid()
    const torrent = await writeTorrentFixture(lastMetadataDir())
    await onBtComplete({ gid })

    expect(torrentParser.parse).toHaveBeenCalledWith(torrent.base64)

    const emit = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === Events.MagnetFileSelection
    )
    expect(emit?.[1].meta.files).toHaveLength(3)
    expect(emit?.[1].meta.files.map((f: { path: string }) => f.path)).toEqual([
      'multi/video.mkv',
      'multi/readme.txt',
      'multi/cover.jpg',
    ])
  })

  it('promotes aggStatus to MetadataReady on completion so the Downloads pill flips off "Fetching"', async () => {
    // Bug 1: before the fix, onComplete only emitted
    // MagnetFileSelection — DB aggStatus + TaskManager.status stayed
    // on FetchingMetadata until the user confirmed file selection.
    // The Downloads list pill said "Fetching" forever, which is
    // misleading: the metadata is already in the user's lap.
    const infoHash = 'e'.repeat(40)
    const saveDir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-ready')
    torrentParser.parse.mockResolvedValue({
      name: 'resolved-name.torrent',
      infoHash,
      totalSize: 4096,
      files: [{ index: 0, path: 'a/file.bin', size: 4096, extension: '.bin' }],
      comment: null,
      isPrivate: false,
    })

    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    const onBtComplete = rpc.onBtDownloadComplete.mock.calls[0][0]

    const taskId = await tracker.submit(
      `magnet:?xt=urn:btih:${infoHash}`,
      saveDir
    )
    await writeTorrentFixture(lastMetadataDir())
    await onBtComplete({ gid: 'g-meta-ready' })

    const after = db.getTask(taskId)
    expect(after?.task.aggStatus).toBe(TaskStatus.MetadataReady)
    expect(after?.instances[0].status).toBe(TaskStatus.MetadataReady)
    // The placeholder name is upgraded to the resolved torrent name
    // so the row stops showing the raw magnet URI.
    expect(after?.task.name).toBe('resolved-name.torrent')

    const tmTask = taskManager.getById(taskId)
    expect(tmTask?.status).toBe(TaskStatus.MetadataReady)

    // Both MagnetFileSelection (dialog trigger) and TaskUpdated
    // (Downloads list refresh) must fire.
    const emits = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0]
    )
    expect(emits).toContain(Events.MagnetFileSelection)
    expect(emits).toContain(Events.TaskUpdated)
  })

  it('keeps a restart-safe quarantine owner when metadata result purge is unconfirmed', async () => {
    const saveDir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-result-purge-failed')
    rpc.removeDownloadResult.mockRejectedValue(new Error('ECONNREFUSED'))
    rpc.remove.mockRejectedValue(new Error('ECONNREFUSED'))
    rpc.forceRemove.mockRejectedValue(new Error('ECONNREFUSED'))

    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    const onComplete = rpc.onDownloadComplete.mock.calls[0][0]
    const taskId = await tracker.submit(
      'magnet:?xt=urn:btih:result-purge-failed',
      saveDir
    )
    await writeTorrentFixture(lastMetadataDir())

    await onComplete({ gid: 'g-meta-result-purge-failed' })

    const failed = db.getTask(taskId)
    expect(failed?.task).toMatchObject({
      aggStatus: TaskStatus.Error,
      errorCode: DownloadErrorCode.BtMetadataFailed,
      errorMessage: 'Magnet metadata result cleanup could not be confirmed',
    })
    expect(failed?.instances[0]).toMatchObject({
      gid: 'g-meta-result-purge-failed',
      status: TaskStatus.Error,
      payload: {
        cleanupQuarantined: true,
        cleanupTombstoneHidden: false,
      },
    })
    expect(taskManager.getById(taskId)?.status).toBe(TaskStatus.Error)
    expect(
      tracker.observe({
        gid: 'g-meta-result-purge-failed',
        status: 'complete',
      } as never)
    ).toBe(true)
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      Events.MagnetFileSelection,
      expect.anything()
    )

    await tracker.stopAndDrain()
    const restartedTaskManager = createMockTaskManager()
    const restartedTracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      restartedTaskManager,
      torrentParser
    )
    restartedTracker.primeFromDatabase()

    expect(
      restartedTracker.observe({
        gid: 'g-meta-result-purge-failed',
        status: 'complete',
      } as never)
    ).toBe(true)
    await restartedTracker.stopAndDrain()
  })

  it('keeps MetadataReady when a TaskUpdated listener throws (bus isolates, no cleanup)', async () => {
    const saveDir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-task-updated-throws')
    const onListenerError = vi.fn()
    const realEventBus = new EventBus({ onListenerError })
    const emitSpy = vi.spyOn(realEventBus, 'emit')
    const tracker = createMagnetTracker(
      rpc as never,
      realEventBus,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    const onComplete = rpc.onDownloadComplete.mock.calls[0][0]
    const taskId = await tracker.submit(
      'magnet:?xt=urn:btih:task-updated-throws',
      saveDir
    )
    await writeTorrentFixture(lastMetadataDir())
    emitSpy.mockClear()
    const listenerError = new Error('TaskUpdated listener failed')
    realEventBus.on(Events.TaskUpdated, () => {
      throw listenerError
    })

    await expect(
      onComplete({ gid: 'g-meta-task-updated-throws' })
    ).resolves.toBeUndefined()

    expect(onListenerError).toHaveBeenCalledTimes(1)
    expect(onListenerError).toHaveBeenCalledWith(
      Events.TaskUpdated,
      listenerError
    )
    expect(db.getTask(taskId)?.task.aggStatus).toBe(TaskStatus.MetadataReady)
    expect(db.getTask(taskId)?.instances[0].status).toBe(
      TaskStatus.MetadataReady
    )
    expect(taskManager.getById(taskId)?.status).toBe(TaskStatus.MetadataReady)
    expect(emitSpy.mock.calls.map((call) => call[0])).toEqual([
      Events.TaskUpdated,
      Events.MagnetFileSelection,
    ])
    expect(rpc.forceRemove).not.toHaveBeenCalled()
    expect(
      tracker.observe({
        gid: 'g-meta-task-updated-throws',
        status: 'complete',
      } as never)
    ).toBe(true)
  })

  it('keeps MetadataReady when a MagnetFileSelection listener throws (bus isolates, no cleanup)', async () => {
    const saveDir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-file-selection-throws')
    const onListenerError = vi.fn()
    const realEventBus = new EventBus({ onListenerError })
    const emitSpy = vi.spyOn(realEventBus, 'emit')
    const tracker = createMagnetTracker(
      rpc as never,
      realEventBus,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    const onComplete = rpc.onBtDownloadComplete.mock.calls[0][0]
    const taskId = await tracker.submit(
      'magnet:?xt=urn:btih:file-selection-throws',
      saveDir
    )
    await writeTorrentFixture(lastMetadataDir())
    emitSpy.mockClear()
    const listenerError = new Error('MagnetFileSelection listener failed')
    realEventBus.on(Events.MagnetFileSelection, () => {
      throw listenerError
    })

    await expect(
      onComplete({ gid: 'g-meta-file-selection-throws' })
    ).resolves.toBeUndefined()

    expect(onListenerError).toHaveBeenCalledTimes(1)
    expect(onListenerError).toHaveBeenCalledWith(
      Events.MagnetFileSelection,
      listenerError
    )
    expect(db.getTask(taskId)?.task.aggStatus).toBe(TaskStatus.MetadataReady)
    expect(db.getTask(taskId)?.instances[0].status).toBe(
      TaskStatus.MetadataReady
    )
    expect(taskManager.getById(taskId)?.status).toBe(TaskStatus.MetadataReady)
    expect(emitSpy.mock.calls.map((call) => call[0])).toEqual([
      Events.TaskUpdated,
      Events.MagnetFileSelection,
    ])
    expect(rpc.forceRemove).not.toHaveBeenCalled()
    expect(
      tracker.observe({
        gid: 'g-meta-file-selection-throws',
        status: 'complete',
      } as never)
    ).toBe(true)
  })

  it('commits a visible terminal Error when completed metadata cannot be read and cleanup succeeds', async () => {
    const saveDir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-read-failed')
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    const onComplete = rpc.onDownloadComplete.mock.calls[0][0]
    const taskId = await tracker.submit(
      'magnet:?xt=urn:btih:read-failed',
      saveDir
    )
    eventBus.emit.mockClear()

    // Leave the metadata directory without a .torrent file.
    await onComplete({ gid: 'g-meta-read-failed' })

    const saved = db.getTask(taskId)
    expect(saved?.task).toMatchObject({
      aggStatus: TaskStatus.Error,
      finishedAt: expect.any(Number),
      errorMessage: 'Magnet metadata processing failed',
      errorCode: DownloadErrorCode.BtMetadataFailed,
    })
    expect(saved?.instances[0]).toMatchObject({
      status: TaskStatus.Error,
      payload: expect.objectContaining({
        cleanupQuarantined: false,
        cleanupTombstoneHidden: false,
      }),
    })
    expect(taskManager.getById(taskId)).toMatchObject({
      status: TaskStatus.Error,
      errorCode: DownloadErrorCode.BtMetadataFailed,
    })
    expect(eventBus.emit).toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Array)
    )
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      Events.MagnetFileSelection,
      expect.anything()
    )
    expect(
      tracker.observe({
        gid: 'g-meta-read-failed',
        status: 'complete',
      } as never)
    ).toBe(false)
  })

  it('keeps parse failure terminal and visible when cleanup reaches MAX', async () => {
    const saveDir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-parse-failed')
    rpc.forceRemove.mockRejectedValue(new Error('ECONNREFUSED'))
    rpc.removeDownloadResult.mockRejectedValue(new Error('ECONNREFUSED'))
    torrentParser.parse.mockRejectedValue(new Error('invalid bencode'))
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    const onComplete = rpc.onBtDownloadComplete.mock.calls[0][0]
    const taskId = await tracker.submit(
      'magnet:?xt=urn:btih:parse-failed',
      saveDir
    )
    await writeTorrentFixture(lastMetadataDir())
    eventBus.emit.mockClear()

    await onComplete({ gid: 'g-meta-parse-failed' })
    await vi.advanceTimersByTimeAsync(400_000)

    const saved = db.getTask(taskId)
    expect(rpc.forceRemove).toHaveBeenCalledTimes(6)
    expect(saved?.task).toMatchObject({
      aggStatus: TaskStatus.Error,
      finishedAt: expect.any(Number),
      errorMessage: 'Magnet metadata processing failed',
      errorCode: DownloadErrorCode.BtMetadataFailed,
    })
    expect(saved?.instances[0]).toMatchObject({
      status: TaskStatus.Error,
      payload: expect.objectContaining({
        cleanupQuarantined: true,
        cleanupTombstoneHidden: false,
      }),
    })
    expect(taskManager.getById(taskId)).toMatchObject({
      status: TaskStatus.Error,
      errorCode: DownloadErrorCode.BtMetadataFailed,
    })
    expect(eventBus.emit).toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Array)
    )
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      Events.MagnetFileSelection,
      expect.anything()
    )
    expect(
      tracker.observe({
        gid: 'g-meta-parse-failed',
        status: 'complete',
      } as never)
    ).toBe(true)
  })

  // ── 5. onComplete for unknown gid ────────────────────────────

  it('does nothing when onComplete fires for unknown gid', async () => {
    const _tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    const onComplete = rpc.onDownloadComplete.mock.calls[0][0]

    await onComplete({ gid: 'unknown-gid' })

    expect(rpc.getFiles).not.toHaveBeenCalled()
    expect(eventBus.emit).not.toHaveBeenCalled()
  })

  // ── 6. onError for known gid ─────────────────────────────────

  it('cleans up without emitting MagnetFileSelection when onError fires for known gid', async () => {
    const dir = await makeTempDir()
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    const onError = rpc.onDownloadError.mock.calls[0][0]

    const taskId = await tracker.submit('magnet:?xt=urn:btih:abc123', dir)
    const gid = lastMetadataGid()
    eventBus.emit.mockClear()

    await onError({ gid })

    expect(rpc.forceRemove).toHaveBeenCalledWith(gid)
    const saved = db.getTask(taskId)
    expect(saved?.task).toMatchObject({
      aggStatus: TaskStatus.Error,
      finishedAt: expect.any(Number),
      errorMessage: 'Magnet metadata fetch failed',
      errorCode: DownloadErrorCode.BtMetadataFailed,
    })
    expect(saved?.instances[0]).toMatchObject({
      status: TaskStatus.Error,
      payload: expect.objectContaining({ cleanupQuarantined: false }),
    })
    expect(taskManager.getById(taskId)).toMatchObject({
      status: TaskStatus.Error,
      finishedAt: saved?.task.finishedAt,
      errorCode: DownloadErrorCode.BtMetadataFailed,
    })
    expect(eventBus.emit).toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Array)
    )
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      Events.MagnetFileSelection,
      expect.anything()
    )
  })

  it('writes the terminal occurrence with cause "engine" and dispatches it when onError fires', async () => {
    const dir = await makeTempDir()
    const dispatch = vi.fn(async () => {})
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser,
      undefined,
      { occurrenceDispatcher: { dispatch } }
    )
    const onError = rpc.onDownloadError.mock.calls[0][0]

    const taskId = await tracker.submit('magnet:?xt=urn:btih:abc123', dir)
    const gid = lastMetadataGid()

    await onError({ gid })

    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: 'terminal',
        taskId,
        fromStatus: TaskStatus.FetchingMetadata,
        toStatus: TaskStatus.Error,
        cause: 'engine',
        errorGroup: expect.objectContaining({
          errorCode: DownloadErrorCode.BtMetadataFailed,
          errorMessage: 'Magnet metadata fetch failed',
        }),
      })
    )
    expect(db.persistTaskWithOccurrence).toHaveBeenCalledOnce()
  })

  it('does not turn a normal metadata Error into a hidden tombstone when cleanup reaches MAX', async () => {
    const dir = await makeTempDir()
    rpc.forceRemove.mockRejectedValue(new Error('ECONNREFUSED'))
    rpc.removeDownloadResult.mockRejectedValue(new Error('ECONNREFUSED'))
    const dispatch = vi.fn(async () => {})
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser,
      undefined,
      { occurrenceDispatcher: { dispatch } }
    )
    const onError = rpc.onDownloadError.mock.calls[0][0]

    const taskId = await tracker.submit(
      'magnet:?xt=urn:btih:visible-after-restart',
      dir
    )
    const gid = lastMetadataGid()
    await onError({ gid })
    await vi.advanceTimersByTimeAsync(400_000)

    const saved = db.getTask(taskId)
    expect(rpc.forceRemove).toHaveBeenCalledTimes(6)
    expect(saved?.task.aggStatus).toBe(TaskStatus.Error)
    expect(saved?.instances[0].payload).toMatchObject({
      cleanupQuarantined: true,
      cleanupTombstoneHidden: false,
    })
    expect(taskManager.getById(taskId)?.status).toBe(TaskStatus.Error)
    expect(tracker.observe({ gid, status: 'active' } as never)).toBe(true)
    // Not a hidden tombstone (cleanupTombstoneHidden: false above) — the
    // initial onError (markMetadataFailure) commit emits a user-visible
    // occurrence. The later deferCleanup give-up branch does NOT emit a
    // second one: the task is already Error by then, so the same-status
    // guard in buildTerminalOccurrence correctly no-ops it (proving the
    // hidden-tombstone gate isn't what's suppressing it here).
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        taskId,
        cause: 'engine',
        fromStatus: TaskStatus.FetchingMetadata,
        toStatus: TaskStatus.Error,
      })
    )
  })

  // ── 7. Timeout ────────────────────────────────────────────────

  it('cleans up after magnetResolveTimeout expires', async () => {
    const dir = await makeTempDir()
    settings = createMockSettingsManager({ magnetResolveTimeout: 60 })
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    const taskId = await tracker.submit('magnet:?xt=urn:btih:abc123', dir)
    const gid = lastMetadataGid()
    eventBus.emit.mockClear()

    // Advance time by 60 seconds (timeout)
    await vi.advanceTimersByTimeAsync(60 * 1000)

    expect(rpc.forceRemove).toHaveBeenCalledWith(gid)
    const saved = db.getTask(taskId)
    expect(saved?.task).toMatchObject({
      aggStatus: TaskStatus.Error,
      finishedAt: expect.any(Number),
      errorMessage: 'Magnet metadata fetch timed out',
      errorCode: DownloadErrorCode.Timeout,
    })
    expect(taskManager.getById(taskId)?.status).toBe(TaskStatus.Error)
    expect(eventBus.emit).toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Array)
    )
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      Events.MagnetFileSelection,
      expect.anything()
    )
  })

  // ── 8. Plan B: DB-backed pending magnet ───────────────────────

  it('submit() writes tasks + magnet_metadata_resolution instance to db', async () => {
    const dir = await makeTempDir()
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    const taskId = await tracker.submit('magnet:?xt=urn:btih:abc', dir)
    const gid = lastMetadataGid()

    expect(taskId).toMatch(/.+/)
    expect(db.saveTaskWithInstances).toHaveBeenCalledOnce()
    const saved = (db.saveTaskWithInstances as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as TaskWithInstances
    expect(saved.task.kind).toBe(TaskKind.Bt)
    expect(saved.task.aggStatus).toBe(TaskStatus.FetchingMetadata)
    expect(saved.instances).toHaveLength(1)
    expect(saved.instances[0].phase).toBe(
      TaskInstancePhase.MagnetMetadataResolution
    )
    expect(saved.instances[0].gid).toBe(gid)
    expect(saved.instances[0].payload).toMatchObject({
      metadataDir: expect.stringContaining('motrix-magnet-metadata-'),
    })
  })

  it('submit() emits Events.TaskUpdated with the full taskManager snapshot (Bug 1 regression)', async () => {
    // Real-world bug: useTaskList hook in the renderer relies on
    // Events.TaskUpdated to refresh the Downloads list. Without this
    // emit, the magnet metadata row only appears after a manual
    // navigation away + back (which triggers refresh()). Aria2's
    // global stats showed Active=1 because aria2 itself saw the
    // metadata GID, but the renderer never knew about the new row.
    const dir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-emit')
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    await tracker.submit('magnet:?xt=urn:btih:emit', dir)

    const emit = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === Events.TaskUpdated
    )
    expect(emit).toBeDefined()
    // Payload is the full task list snapshot (useTaskList applies it
    // directly when Array.isArray(payload) is true).
    expect(Array.isArray(emit?.[1])).toBe(true)
    expect((emit?.[1] as DownloadTask[])?.length).toBeGreaterThan(0)
    expect(
      (emit?.[1] as DownloadTask[])?.some(
        (t) => t.status === TaskStatus.FetchingMetadata
      )
    ).toBe(true)
  })

  it('observe() recognises a gid that lives in a magnet_metadata_resolution instance', async () => {
    const dir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-1')
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    await tracker.submit('magnet:?xt=urn:btih:abc', dir)

    expect(
      tracker.observe({ gid: 'g-meta-1', status: 'active' } as never)
    ).toBe(true)
  })

  it('observe() returns false for gids that are not magnet_metadata_resolution', () => {
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    expect(tracker.observe({ gid: 'g-other', status: 'active' } as never)).toBe(
      false
    )
  })

  it('observe() self-clears a stale failed-swap shield after the BT owner is installed', async () => {
    const dir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-before-swap')
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    const taskId = await tracker.submit('magnet:?xt=urn:btih:owner-heal', dir)
    const metadataTask = taskManager.getById(taskId)
    if (!metadataTask) throw new Error('metadata task fixture missing')

    tracker.reserveFailedSwapCleanup({
      taskId,
      instanceId: `meta:${taskId}`,
      gid: 'g-bt-committed',
      magnetUri: 'magnet:?xt=urn:btih:owner-heal',
      saveDir: '/Downloads',
      metadataDir: '/Downloads/resolved.motrix',
      torrentMetaPath: '/torrent-meta/owner-heal.torrent',
      artifactPaths: [],
    })
    expect(tracker.hasPendingSwapCleanup(taskId)).toBe(true)

    taskManager.set(taskId, {
      ...metadataTask,
      type: TaskType.Bt,
      status: TaskStatus.Downloading,
      engineTaskId: 'g-bt-committed',
      instances: [
        {
          ...metadataTask.instances[0],
          instanceId: `bt:${taskId}`,
          gid: 'g-bt-committed',
          phase: TaskInstancePhase.BtDownload,
          status: TaskStatus.Downloading,
        },
      ],
    })

    // Models an unexpected explicit release failure: the next poll observes
    // the authoritative TaskManager owner and heals the stale shield rather
    // than suppressing legitimate BT updates indefinitely.
    expect(
      tracker.observe({ gid: 'g-bt-committed', status: 'active' } as never)
    ).toBe(false)
    expect(tracker.hasPendingSwapCleanup(taskId)).toBe(false)
    await tracker.stopAndDrain()
  })

  it('cancel(taskId) calls aria2 forceRemove with the GID, not the instanceId', async () => {
    const dir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-cancel')
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    const taskId = await tracker.submit('magnet:?xt=urn:btih:abc', dir)
    await tracker.cancel(taskId)

    // Regression guard for Codex finding #2: cleanupCacheEntry must
    // delete by aria2 gid and call RPC with the aria2 gid. The legacy bug
    // passed `meta:${taskId}` here and silently failed against aria2.
    expect(rpc.forceRemove).toHaveBeenCalledWith('g-meta-cancel')
    expect(rpc.forceRemove).not.toHaveBeenCalledWith(
      expect.stringMatching(/^meta:/)
    )
  })

  it('cancel(taskId, { deleteTaskRow: false }) leaves the DB task row in place', async () => {
    // Bug 2 fix: swapMagnetMetadataForBt reuses cancel() only to drop
    // the in-memory cache + tear down the aria2 metadata GID — it
    // does NOT want the persistent task row deleted, because swap
    // immediately writes a new bt_download instance under the same
    // motrixId. Removing the row makes the ensuing replaceInstances
    // trip the FK constraint after adapter.addTorrent already
    // accepted a fresh BT GID, leaving aria2 with an orphan.
    const dir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-keep-row')
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    const taskId = await tracker.submit('magnet:?xt=urn:btih:keep', dir)
    expect(db.getTask(taskId)).not.toBeNull()

    await tracker.cancel(taskId, { deleteTaskRow: false })

    expect(rpc.forceRemove).toHaveBeenCalledWith('g-meta-keep-row')
    // cache entry dropped (cleanup succeeded) — observe() no longer
    // shields the gid.
    expect(
      tracker.observe({ gid: 'g-meta-keep-row', status: 'active' } as never)
    ).toBe(false)
    // DB row preserved for the caller (swap) to mutate next.
    expect(db.deleteTask).not.toHaveBeenCalled()
    expect(db.getTask(taskId)).not.toBeNull()
  })

  it('timeout path also forceRemoves by aria2 GID', async () => {
    const dir = await makeTempDir()
    settings = createMockSettingsManager({
      magnetFileSelection: true,
      magnetResolveTimeout: 1,
    })
    rpc.addUri.mockResolvedValue('g-meta-timeout')
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    await tracker.submit('magnet:?xt=urn:btih:def', dir)
    await vi.advanceTimersByTimeAsync(1500)

    expect(rpc.forceRemove).toHaveBeenCalledWith('g-meta-timeout')
    expect(rpc.forceRemove).not.toHaveBeenCalledWith(
      expect.stringMatching(/^meta:/)
    )
  })

  it('retries timed-out metadata under the same task with a fresh GID and double timeout', async () => {
    const dir = await makeTempDir()
    settings = createMockSettingsManager({
      magnetFileSelection: true,
      magnetResolveTimeout: 1,
    })
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    const taskId = await tracker.submit(
      'magnet:?xt=urn:btih:retry-timeout',
      dir
    )
    const firstOptions = rpc.addUri.mock.calls[0][1]
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => {
      expect(db.getTask(taskId)?.task.aggStatus).toBe(TaskStatus.Error)
      expect(
        tracker.observe({ gid: firstOptions?.gid, status: 'removed' } as never)
      ).toBe(false)
    })

    await tracker.retryMetadata(taskId)

    const secondOptions = rpc.addUri.mock.calls[1][1]
    expect(rpc.addUri).toHaveBeenCalledTimes(2)
    expect(firstOptions?.['bt-load-saved-metadata']).toBe('false')
    expect(secondOptions?.['bt-load-saved-metadata']).toBe('false')
    expect(secondOptions?.gid).not.toBe(firstOptions?.gid)
    expect(secondOptions?.dir).not.toBe(firstOptions?.dir)
    expect(db.getTask(taskId)).toMatchObject({
      task: {
        motrixId: taskId,
        aggStatus: TaskStatus.FetchingMetadata,
        errorCode: null,
        errorMessage: null,
      },
      instances: [
        {
          gid: secondOptions?.gid,
          payload: { metadataTimeoutMultiplier: 2 },
        },
      ],
    })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(db.getTask(taskId)?.task.aggStatus).toBe(TaskStatus.FetchingMetadata)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(db.getTask(taskId)?.task.aggStatus).toBe(TaskStatus.Error)
  })

  it('restores the doubled retry timeout from the persisted metadata payload', async () => {
    const dir = await makeTempDir()
    settings = createMockSettingsManager({
      magnetFileSelection: true,
      magnetResolveTimeout: 1,
    })
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    const taskId = await tracker.submit(
      'magnet:?xt=urn:btih:retry-restart',
      dir
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => {
      expect(db.getTask(taskId)?.task.aggStatus).toBe(TaskStatus.Error)
    })
    await tracker.retryMetadata(taskId)
    await tracker.stopAndDrain()

    const restarted = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    restarted.primeFromDatabase()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(db.getTask(taskId)?.task.aggStatus).toBe(TaskStatus.FetchingMetadata)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(db.getTask(taskId)?.task.aggStatus).toBe(TaskStatus.Error)
  })

  it('does not start a metadata retry until old GID cleanup is confirmed', async () => {
    const dir = await makeTempDir()
    settings = createMockSettingsManager({
      magnetFileSelection: true,
      magnetResolveTimeout: 1,
    })
    rpc.forceRemove.mockRejectedValue(new Error('ECONNREFUSED'))
    rpc.removeDownloadResult.mockRejectedValue(new Error('ECONNREFUSED'))
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    const taskId = await tracker.submit(
      'magnet:?xt=urn:btih:retry-cleanup-pending',
      dir
    )
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(tracker.retryMetadata(taskId)).rejects.toMatchObject({
      code: ErrorCode.MagnetCleanupPending,
    })
    expect(rpc.addUri).toHaveBeenCalledTimes(1)
  })

  it('error event path also forceRemoves by aria2 GID', async () => {
    const dir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-err')
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    const onError = rpc.onDownloadError.mock.calls[0][0]

    await tracker.submit('magnet:?xt=urn:btih:err', dir)
    await onError({ gid: 'g-meta-err' })

    expect(rpc.forceRemove).toHaveBeenCalledWith('g-meta-err')
    expect(rpc.forceRemove).not.toHaveBeenCalledWith(
      expect.stringMatching(/^meta:/)
    )
  })

  it('cleanup preserves cache entry when forceRemove fails with a transient error', async () => {
    // Codex finding #3 regression guard: a transient RPC failure
    // (ECONNREFUSED / timeout / connection blip) must NOT cause the
    // cache entry to be dropped, because aria2 might still be running
    // the metadata fetch. observe() must keep returning true so polling
    // won't adopt the GID as a normal task.
    const dir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-flaky')
    rpc.forceRemove.mockRejectedValue(new Error('ECONNREFUSED'))
    rpc.removeDownloadResult.mockRejectedValue(new Error('ECONNREFUSED'))

    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    const taskId = await tracker.submit('magnet:?xt=urn:btih:flaky', dir)
    await tracker.cancel(taskId)

    expect(rpc.forceRemove).toHaveBeenCalledWith('g-meta-flaky')
    expect(
      tracker.observe({ gid: 'g-meta-flaky', status: 'active' } as never)
    ).toBe(true)
  })

  it('cleanup completes when result purge proves absence after forceRemove fails', async () => {
    const dir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-stopped')
    rpc.forceRemove.mockRejectedValue(new Error('task is not active'))
    rpc.removeDownloadResult.mockResolvedValue('OK')

    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    const taskId = await tracker.submit(
      'magnet:?xt=urn:btih:stopped-result',
      dir
    )
    await expect(tracker.cancel(taskId)).resolves.toBe('removed')

    expect(rpc.forceRemove).toHaveBeenCalledWith('g-meta-stopped')
    expect(rpc.removeDownloadResult).toHaveBeenCalledWith('g-meta-stopped')
    expect(
      tracker.observe({ gid: 'g-meta-stopped', status: 'complete' } as never)
    ).toBe(false)
  })

  it('cleanup completes when forceRemove returns not-found (aria2 already removed)', async () => {
    // Counterpart: a not-found error means aria2 confirms the task is
    // gone, so we treat it as a successful cleanup and drop the cache.
    const dir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-gone')
    rpc.forceRemove.mockRejectedValue(new Error('GID#g-meta-gone not found'))
    rpc.removeDownloadResult.mockRejectedValue(
      new Error('GID#g-meta-gone not found')
    )

    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    const taskId = await tracker.submit('magnet:?xt=urn:btih:gone', dir)
    await tracker.cancel(taskId)

    expect(
      tracker.observe({ gid: 'g-meta-gone', status: 'active' } as never)
    ).toBe(false)
  })

  it('does NOT treat HTTP 404 / proxy not-found as GID gone (Codex finding #10)', async () => {
    // A misconfigured proxy returning "404 Not Found" must be classified
    // as transient (retry-eligible), not as a confirmed aria2 GID
    // removal. The narrowed isAria2NotFoundError requires the message to
    // mention the gid or aria2-specific keywords ('gid' / 'download').
    const dir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-proxy')
    rpc.forceRemove.mockRejectedValue(new Error('HTTP 404 Not Found'))
    rpc.removeDownloadResult.mockRejectedValue(new Error('HTTP 404 Not Found'))

    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    const taskId = await tracker.submit('magnet:?xt=urn:btih:proxy', dir)
    await tracker.cancel(taskId)

    // Cache entry preserved because the failure was classified as
    // transient (not as "GID confirmed gone").
    expect(
      tracker.observe({ gid: 'g-meta-proxy', status: 'active' } as never)
    ).toBe(true)
  })

  it('treats aria2 "GID#... not found" as confirmed removal (Codex finding #10)', async () => {
    const dir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-real')
    rpc.forceRemove.mockRejectedValue(
      new Error('GID#g-meta-real is not found in active downloads')
    )
    rpc.removeDownloadResult.mockRejectedValue(
      new Error('GID#g-meta-real is not found in history')
    )

    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    const taskId = await tracker.submit('magnet:?xt=urn:btih:real', dir)
    await tracker.cancel(taskId)

    expect(
      tracker.observe({ gid: 'g-meta-real', status: 'active' } as never)
    ).toBe(false)
  })

  it('cleanup retry eventually succeeds when aria2 recovers', async () => {
    const dir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-recover')
    rpc.forceRemove
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce('OK')
    rpc.removeDownloadResult
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce('OK')

    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    const taskId = await tracker.submit('magnet:?xt=urn:btih:recover', dir)
    await tracker.cancel(taskId)

    // First attempt: cache still present (transient failure).
    expect(
      tracker.observe({ gid: 'g-meta-recover', status: 'active' } as never)
    ).toBe(true)

    // Advance timers past the retry window.
    await vi.advanceTimersByTimeAsync(6000)

    expect(rpc.forceRemove).toHaveBeenCalledTimes(2)
    expect(
      tracker.observe({ gid: 'g-meta-recover', status: 'active' } as never)
    ).toBe(false)
  })

  it('cleanup gives up after MAX_CLEANUP_ATTEMPTS and marks task as error', async () => {
    // Codex finding #5 regression guard + finding #6 quarantine
    // tombstone: after MAX_CLEANUP_ATTEMPTS=6 retries the cache entry
    // is retained (quarantined) so observe() still shields the GID;
    // the DB instance status is marked Error so the task surfaces as
    // failed in the UI.
    const dir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-stuck')
    rpc.forceRemove.mockRejectedValue(new Error('ECONNREFUSED'))
    rpc.removeDownloadResult.mockRejectedValue(new Error('ECONNREFUSED'))
    const dispatch = vi.fn(async () => {})
    const lifecycle = {
      recordTransition: vi.fn().mockResolvedValue(undefined),
      occurrenceDispatcher: { dispatch },
    }

    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser,
      NOOP_TASK_ACTIVITY_RECORDER,
      lifecycle
    )

    const taskId = await tracker.submit('magnet:?xt=urn:btih:stuck', dir)
    await tracker.cancel(taskId)

    await vi.advanceTimersByTimeAsync(400_000)

    expect(rpc.forceRemove).toHaveBeenCalledTimes(6)
    expect(
      tracker.observe({ gid: 'g-meta-stuck', status: 'active' } as never)
    ).toBe(true)

    const saved = db.getTask(taskId)
    expect(saved?.task.aggStatus).toBe(TaskStatus.Error)
    expect(saved?.instances[0].status).toBe(TaskStatus.Error)
    expect(saved?.instances[0].payload.cleanupQuarantined).toBe(true)
    expect(saved?.instances[0].payload.cleanupTombstoneHidden).toBe(true)
    expect(lifecycle.recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        previousStatus: TaskStatus.FetchingMetadata,
        nextStatus: TaskStatus.Error,
        accuracy: 'exact',
        errorMessage: 'Magnet metadata cleanup is quarantined',
      })
    )
    // Hidden tombstone (cleanupTombstoneHidden: true above) — no user-visible
    // occurrence, even though the task row itself carries an Error status.
    expect(dispatch).not.toHaveBeenCalled()
    const occurrenceCalls = vi.mocked(db.persistTaskWithOccurrence).mock.calls
    const giveUpCall = occurrenceCalls.find(
      ([pair]) =>
        pair.task.motrixId === taskId &&
        pair.task.aggStatus === TaskStatus.Error
    )
    expect(giveUpCall?.[1]).toBeNull()
  })

  it('cancel() resets the attempt budget so a quarantined entry can retry', async () => {
    const dir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-revive')
    rpc.forceRemove.mockRejectedValue(new Error('ECONNREFUSED'))
    rpc.removeDownloadResult.mockRejectedValue(new Error('ECONNREFUSED'))

    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    const taskId = await tracker.submit('magnet:?xt=urn:btih:revive', dir)
    await tracker.cancel(taskId)
    await vi.advanceTimersByTimeAsync(400_000)

    // Quarantined: observe() still true, attempts = 6.
    expect(rpc.forceRemove).toHaveBeenCalledTimes(6)
    expect(
      tracker.observe({ gid: 'g-meta-revive', status: 'active' } as never)
    ).toBe(true)

    // Simulate aria2 recovery: subsequent forceRemove resolves.
    rpc.forceRemove.mockReset()
    rpc.forceRemove.mockResolvedValue('OK')
    rpc.removeDownloadResult.mockResolvedValue('OK')

    // User retries removal via UI → cancel(taskId). Budget reset, real
    // cleanup runs.
    await tracker.cancel(taskId)

    expect(rpc.forceRemove).toHaveBeenCalledWith('g-meta-revive')
    expect(
      tracker.observe({ gid: 'g-meta-revive', status: 'active' } as never)
    ).toBe(false)
  })

  it('retry success after quarantined cancel deletes the DB tombstone (Codex finding #15)', async () => {
    // When the user removes a magnet metadata task during a transient
    // aria2 RPC failure, cancel() returns 'quarantined' and removeTask
    // preserves the DB row + marks Error. The background retry timer
    // that cancel armed must, on eventual success, delete that DB row.
    const dir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-user-del')
    rpc.forceRemove
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce('OK')
    rpc.removeDownloadResult
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce('OK')

    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    const taskId = await tracker.submit('magnet:?xt=urn:btih:userdel', dir)
    const result = await tracker.cancel(taskId, { deleteTaskRow: false })
    expect(result).toBe('quarantined')

    // Simulate removeTask's Activity + durable hidden-tombstone barrier. Only
    // after this commits may it hand deferred parent deletion back to the
    // tracker; the first cancel intentionally did not own that deletion.
    const seeded = db.getTask(taskId)
    if (seeded) {
      db.saveTaskWithInstances({
        task: { ...seeded.task, aggStatus: TaskStatus.Error },
        instances: seeded.instances.map((i) => ({
          ...i,
          status: TaskStatus.Error,
          payload: {
            ...i.payload,
            cleanupQuarantined: true,
            cleanupTombstoneHidden: true,
          },
          updatedAt: Date.now(),
        })),
      })
    }
    taskManager.remove(taskId)
    tracker.markPendingUserDelete(taskId)
    expect(db.getTask(taskId)).not.toBeNull()

    await vi.advanceTimersByTimeAsync(6000)

    expect(rpc.forceRemove).toHaveBeenCalledTimes(2)
    expect(
      tracker.observe({ gid: 'g-meta-user-del', status: 'active' } as never)
    ).toBe(false)
    expect(db.getTask(taskId)).toBeNull()

    // Verify the prime side: simulate restart by constructing a fresh
    // tracker against the same db.
    const tracker2 = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    tracker2.primeFromDatabase()
    expect(
      tracker2.observe({ gid: 'g-meta-user-del', status: 'active' } as never)
    ).toBe(false)
  })

  it('re-arms cleanup when durable parent deletion fails after engine cleanup', async () => {
    const dir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-delete-retry')
    const deleteParentTask = vi
      .fn()
      .mockRejectedValueOnce(new Error('delete transaction busy'))
      .mockImplementationOnce(
        async (_taskId: string, deleteParent: () => void | Promise<void>) => {
          await deleteParent()
        }
      )
    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser,
      NOOP_TASK_ACTIVITY_RECORDER,
      { deleteParentTask }
    )

    const taskId = await tracker.submit('magnet:?xt=urn:btih:delete-retry', dir)
    await expect(tracker.cancel(taskId)).resolves.toBe('quarantined')

    expect(deleteParentTask).toHaveBeenCalledTimes(1)
    expect(db.getTask(taskId)).not.toBeNull()
    expect(
      tracker.observe({
        gid: 'g-meta-delete-retry',
        status: 'removed',
      } as never)
    ).toBe(true)

    await vi.advanceTimersByTimeAsync(5_000)

    expect(deleteParentTask).toHaveBeenCalledTimes(2)
    expect(db.getTask(taskId)).toBeNull()
    expect(
      tracker.observe({
        gid: 'g-meta-delete-retry',
        status: 'removed',
      } as never)
    ).toBe(false)
  })

  it('primeFromDatabase resumes bounded cleanup for a hidden user-delete tombstone', async () => {
    // A hidden row has no UI entry through which the user can retry cleanup.
    // Restart must therefore restore the adoption shield and schedule cleanup
    // instead of freezing the entry at MAX attempts forever.
    db.saveTaskWithInstances({
      task: {
        motrixId: 'm-quarantined',
        name: '[METADATA] xyz',
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
        aggStatus: TaskStatus.Error,
        finishedAt: 1700000001,
        errorMessage: 'quarantined',
        errorCode: null,
        errorDetailKey: null,
        errorDetailParams: null,
        diagnosisRevision: 0,
        uploadedBytesBaseline: 0,
        source: 'user',
        sourceMeta: null,
      },
      instances: [
        {
          instanceId: 'meta:m-quarantined',
          motrixId: 'm-quarantined',
          gid: 'g-meta-quarantined',
          phase: TaskInstancePhase.MagnetMetadataResolution,
          status: TaskStatus.Error,
          progress: 0,
          totalBytes: 0,
          downloadedBytes: 0,
          uploadedBytes: 0,
          diskPath: '/tmp/motrix-magnet-metadata-x',
          transitionPhase: TransitionPhase.Idle,
          uris: ['magnet:?xt=urn:btih:quarantined'],
          uriHash: null,
          payload: {
            metadataDir: '/tmp/motrix-magnet-metadata-x',
            cleanupQuarantined: true,
            cleanupTombstoneHidden: true,
          },
          createdAt: 1700000000,
          updatedAt: 1700000001,
        },
      ],
    })

    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    tracker.primeFromDatabase()

    expect(
      tracker.observe({
        gid: 'g-meta-quarantined',
        status: 'active',
      } as never)
    ).toBe(true)

    await vi.advanceTimersByTimeAsync(5_000)

    expect(rpc.forceRemove).toHaveBeenCalledWith('g-meta-quarantined')
    expect(
      tracker.observe({
        gid: 'g-meta-quarantined',
        status: 'active',
      } as never)
    ).toBe(false)
    expect(db.getTask('m-quarantined')).toBeNull()
  })

  it('recovers a failed-swap gid and its artifacts from a durable tombstone after restart', async () => {
    const root = await makeTempDir()
    const diskPath = path.join(root, 'resolved.motrix')
    const torrentMetaPath = path.join(root, 'm-swap-restart.torrent')
    await mkdir(diskPath)
    await writeFile(path.join(diskPath, 'partial.bin'), 'partial')
    await writeFile(torrentMetaPath, 'torrent')

    const originalTask: TaskRow = {
      motrixId: 'm-swap-restart',
      name: '[METADATA] resolved',
      kind: TaskKind.Bt,
      taskType: TaskType.Magnet,
      category: null,
      priority: 0,
      tags: null,
      createdAt: 1700000000,
      updatedAt: 1700000001,
      finalPath: root,
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
    const originalInstance: TaskInstanceRow = {
      instanceId: 'meta:m-swap-restart',
      motrixId: 'm-swap-restart',
      gid: 'g-meta-original',
      phase: TaskInstancePhase.MagnetMetadataResolution,
      status: TaskStatus.MetadataReady,
      progress: 100,
      totalBytes: 0,
      downloadedBytes: 0,
      uploadedBytes: 0,
      diskPath: '/tmp/original-metadata',
      transitionPhase: TransitionPhase.Idle,
      uris: ['magnet:?xt=urn:btih:restart'],
      uriHash: null,
      payload: { metadataDir: '/tmp/original-metadata' },
      createdAt: 1700000000,
      updatedAt: 1700000001,
    }
    const originalFiles: TaskFileRow[] = [
      { fileIndex: 7, path: '/old/selection.bin', size: 17, selected: true },
    ]
    const restoreGraph: TaskWithInstancesAndFiles = {
      task: originalTask,
      instances: [originalInstance],
      files: originalFiles,
    }
    db.saveTaskWithInstancesAndFiles({
      task: {
        ...originalTask,
        torrentMetaPath,
        aggStatus: TaskStatus.Error,
        finishedAt: 1700000001,
        errorMessage: 'Magnet swap cleanup is quarantined',
      },
      instances: [
        {
          ...originalInstance,
          gid: 'g-bt-orphan',
          status: TaskStatus.Error,
          diskPath,
          payload: withMagnetCleanupRestoreGraph(
            {
              metadataDir: diskPath,
              cleanupQuarantined: true,
              cleanupTombstoneHidden: true,
              cleanupArtifactPaths: [diskPath, torrentMetaPath],
            },
            restoreGraph
          ),
        },
      ],
      files: originalFiles,
    })

    const preRestartTracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser,
      NOOP_TASK_ACTIVITY_RECORDER,
      { torrentMetaDir: root }
    )
    const cleanupReservation = {
      taskId: 'm-swap-restart',
      instanceId: 'meta:m-swap-restart',
      gid: 'g-bt-orphan',
      magnetUri: 'magnet:?xt=urn:btih:restart',
      saveDir: root,
      metadataDir: diskPath,
      torrentMetaPath,
      artifactPaths: [diskPath, torrentMetaPath],
      restoreGraph,
    }
    preRestartTracker.reserveFailedSwapCleanup(cleanupReservation)
    expect(preRestartTracker.hasPendingSwapCleanup('m-swap-restart')).toBe(true)
    expect(
      preRestartTracker.observe({
        gid: 'g-bt-orphan',
        status: 'active',
      } as never)
    ).toBe(true)
    preRestartTracker.releaseFailedSwapCleanup('m-swap-restart', 'g-bt-orphan')
    expect(preRestartTracker.hasPendingSwapCleanup('m-swap-restart')).toBe(
      false
    )

    preRestartTracker.registerFailedSwapCleanup({
      ...cleanupReservation,
      deleteParentOnSuccess: false,
    })
    expect(preRestartTracker.hasPendingSwapCleanup('m-swap-restart')).toBe(true)
    expect(
      preRestartTracker.observe({
        gid: 'g-bt-orphan',
        status: 'active',
      } as never)
    ).toBe(true)
    await preRestartTracker.stopAndDrain()

    vi.mocked(db.saveTaskWithInstancesAndFiles).mockImplementationOnce(() => {
      throw new Error('restore transaction busy')
    })
    const restartedTracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser,
      NOOP_TASK_ACTIVITY_RECORDER,
      { torrentMetaDir: root }
    )
    restartedTracker.primeFromDatabase()

    expect(restartedTracker.hasPendingSwapCleanup('m-swap-restart')).toBe(true)
    expect(
      restartedTracker.observe({
        gid: 'g-bt-orphan',
        status: 'active',
      } as never)
    ).toBe(true)

    await expect(
      restartedTracker.cancel('m-swap-restart', { deleteTaskRow: false })
    ).resolves.toBe('quarantined')

    expect(rpc.forceRemove).toHaveBeenCalledWith('g-bt-orphan')
    expect(rpc.removeDownloadResult).toHaveBeenCalledWith('g-bt-orphan')
    expect(restartedTracker.hasPendingSwapCleanup('m-swap-restart')).toBe(true)
    expect(db.getTask('m-swap-restart')?.task.aggStatus).toBe(TaskStatus.Error)

    // The first durable restore failed after engine/artifact cleanup. The
    // same cache owner must remain shielded and retry finalization.
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(5_000)

    vi.useRealTimers()
    await vi.waitFor(async () => {
      await expect(access(diskPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(torrentMetaPath)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(db.getTask('m-swap-restart')).toEqual({
        task: originalTask,
        instances: [originalInstance],
      })
      expect(db.getTaskFiles('m-swap-restart')).toEqual(originalFiles)
      expect(taskManager.getById('m-swap-restart')).toMatchObject({
        id: 'm-swap-restart',
        status: TaskStatus.MetadataReady,
        createdAt: originalTask.createdAt,
      })
      expect(restartedTracker.hasPendingSwapCleanup('m-swap-restart')).toBe(
        false
      )
    })
  })

  it('refuses failed-swap artifact paths outside trusted save and torrent roots', async () => {
    const root = await makeTempDir()
    const saveDir = path.join(root, 'downloads')
    const outsideDir = path.join(root, 'outside')
    const unsafeMotrixPath = path.join(outsideDir, 'poisoned.motrix')
    const unsafeTorrentPath = path.join(outsideDir, 'm-path-guard.torrent')
    await mkdir(saveDir)
    await mkdir(unsafeMotrixPath, { recursive: true })
    await writeFile(path.join(unsafeMotrixPath, 'keep.bin'), 'keep')
    await writeFile(unsafeTorrentPath, 'keep')

    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser,
      NOOP_TASK_ACTIVITY_RECORDER,
      { torrentMetaDir: path.join(root, 'trusted-torrents') }
    )
    tracker.registerFailedSwapCleanup({
      taskId: 'm-path-guard',
      instanceId: 'meta:m-path-guard',
      gid: 'g-path-guard',
      magnetUri: 'magnet:?xt=urn:btih:path-guard',
      saveDir,
      metadataDir: unsafeMotrixPath,
      torrentMetaPath: unsafeTorrentPath,
      artifactPaths: [unsafeMotrixPath, unsafeTorrentPath],
      deleteParentOnSuccess: false,
    })

    await vi.advanceTimersByTimeAsync(5_000)

    await expect(access(unsafeMotrixPath)).resolves.toBeUndefined()
    await expect(access(unsafeTorrentPath)).resolves.toBeUndefined()
    expect(tracker.hasPendingSwapCleanup('m-path-guard')).toBe(true)
    expect(
      tracker.observe({ gid: 'g-path-guard', status: 'removed' } as never)
    ).toBe(true)
    await tracker.stopAndDrain()
  })

  it('cleans only the indexed workspace derived from the failed swap task id', async () => {
    const root = await makeTempDir()
    const saveDir = path.join(root, 'downloads')
    const taskId = 'm-indexed-cleanup'
    const workspacePath = btWorkspacePath(taskId, saveDir)
    await mkdir(workspacePath, { recursive: true })
    await writeFile(path.join(workspacePath, 'partial.bin'), 'partial')

    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    tracker.registerFailedSwapCleanup({
      taskId,
      instanceId: `meta:${taskId}`,
      gid: 'g-indexed-cleanup',
      magnetUri: 'magnet:?xt=urn:btih:indexed-cleanup',
      saveDir,
      metadataDir: workspacePath,
      torrentMetaPath: null,
      artifactPaths: [workspacePath],
      deleteParentOnSuccess: false,
    })

    await vi.advanceTimersByTimeAsync(5_000)
    vi.useRealTimers()
    await vi.waitFor(async () => {
      await expect(access(workspacePath)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(tracker.hasPendingSwapCleanup(taskId)).toBe(false)
    })
  })

  it('primeFromDatabase shields a normal metadata Error without a new timeout', () => {
    db.saveTaskWithInstances({
      task: {
        motrixId: 'm-visible-error',
        name: '[METADATA] failed',
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
        aggStatus: TaskStatus.Error,
        finishedAt: 1700000001,
        errorMessage: 'Magnet metadata fetch failed',
        errorCode: DownloadErrorCode.BtMetadataFailed,
        errorDetailKey: null,
        errorDetailParams: null,
        diagnosisRevision: 0,
        uploadedBytesBaseline: 0,
        source: 'user',
        sourceMeta: null,
      },
      instances: [
        {
          instanceId: 'meta:m-visible-error',
          motrixId: 'm-visible-error',
          gid: 'g-meta-visible-error',
          phase: TaskInstancePhase.MagnetMetadataResolution,
          status: TaskStatus.Error,
          progress: 0,
          totalBytes: 0,
          downloadedBytes: 0,
          uploadedBytes: 0,
          diskPath: '/tmp/motrix-magnet-metadata-visible',
          transitionPhase: TransitionPhase.Idle,
          uris: ['magnet:?xt=urn:btih:visible'],
          uriHash: null,
          payload: {
            metadataDir: '/tmp/motrix-magnet-metadata-visible',
            cleanupQuarantined: true,
            cleanupTombstoneHidden: false,
          },
          createdAt: 1700000000,
          updatedAt: 1700000001,
        },
      ],
    })

    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    tracker.primeFromDatabase()

    expect(
      tracker.observe({
        gid: 'g-meta-visible-error',
        status: 'error',
      } as never)
    ).toBe(true)

    // A normal terminal Error is not a resumed metadata fetch. No timeout or
    // automatic cleanup should run after restart.
    vi.advanceTimersByTime(400_000)
    expect(rpc.forceRemove).not.toHaveBeenCalled()
  })

  it('dispose() cancels all in-flight cleanup retry timers', async () => {
    const dir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-shutdown')
    rpc.forceRemove.mockRejectedValue(new Error('ECONNREFUSED'))
    rpc.removeDownloadResult.mockRejectedValue(new Error('ECONNREFUSED'))

    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    const taskId = await tracker.submit('magnet:?xt=urn:btih:shutdown', dir)
    await tracker.cancel(taskId)
    expect(
      tracker.observe({ gid: 'g-meta-shutdown', status: 'active' } as never)
    ).toBe(true)

    tracker.dispose()

    expect(
      tracker.observe({ gid: 'g-meta-shutdown', status: 'active' } as never)
    ).toBe(false)

    const callCountBefore = (rpc.forceRemove as ReturnType<typeof vi.fn>).mock
      .calls.length
    await vi.advanceTimersByTimeAsync(400_000)
    expect(
      (rpc.forceRemove as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBe(callCountBefore)
  })

  it('stopAndDrain unsubscribes ingress, awaits an in-flight callback, and gates late callbacks', async () => {
    const dir = await makeTempDir()
    rpc.addUri.mockResolvedValue('g-meta-drain')
    let resolveRemove!: (value: string) => void
    rpc.forceRemove.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveRemove = resolve
        })
    )
    const unsubscribeComplete = vi.fn()
    const unsubscribeBtComplete = vi.fn()
    const unsubscribeError = vi.fn()
    rpc.onDownloadComplete.mockReturnValue(unsubscribeComplete)
    rpc.onBtDownloadComplete.mockReturnValue(unsubscribeBtComplete)
    rpc.onDownloadError.mockReturnValue(unsubscribeError)

    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )
    await tracker.submit('magnet:?xt=urn:btih:drain', dir)
    const onError = rpc.onDownloadError.mock.calls[0][0]
    onError({ gid: 'g-meta-drain' })
    for (let i = 0; i < 20 && !resolveRemove; i += 1) {
      await Promise.resolve()
    }

    const drain = tracker.stopAndDrain()
    expect(tracker.stopAndDrain()).toBe(drain)
    expect(unsubscribeComplete).toHaveBeenCalledOnce()
    expect(unsubscribeBtComplete).toHaveBeenCalledOnce()
    expect(unsubscribeError).toHaveBeenCalledOnce()

    let drained = false
    void drain.then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    resolveRemove('OK')
    await drain
    const writesAfterDrain = (
      db.saveTaskWithInstances as ReturnType<typeof vi.fn>
    ).mock.calls.length

    onError({ gid: 'g-meta-drain' })
    await Promise.resolve()
    expect(
      (db.saveTaskWithInstances as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBe(writesAfterDrain)
  })

  it('concurrent cancel + timeout coalesce into one cleanup attempt (Codex finding #14)', async () => {
    // Re-entrancy guard: when cancel + timeout fire for the same entry
    // they coalesce via cleanupInFlight rather than each starting their
    // own cleanup, bumping cleanupAttempts independently, and leaking
    // orphan retry timers past dispose().
    const dir = await makeTempDir()
    settings = createMockSettingsManager({
      magnetFileSelection: true,
      magnetResolveTimeout: 1,
    })
    rpc.addUri.mockResolvedValue('g-meta-race')

    // Build a stalled first forceRemove and capture its resolver via a
    // typed deferred — avoids TypeScript control-flow narrowing the
    // closure-assigned variable to `never` when read outside the
    // executor.
    let resolveFirstForceRemove: (value: 'OK') => void = () => {}
    const firstForceRemovePromise = new Promise<'OK'>((resolve) => {
      resolveFirstForceRemove = resolve
    })
    rpc.forceRemove.mockImplementationOnce(() => firstForceRemovePromise)
    rpc.forceRemove.mockResolvedValue('OK')
    rpc.removeDownloadResult.mockResolvedValue('OK')

    const tracker = createMagnetTracker(
      rpc as never,
      eventBus as never,
      settings as never,
      db,
      taskManager,
      torrentParser
    )

    const taskId = await tracker.submit('magnet:?xt=urn:btih:race', dir)

    const cancelPromise = tracker.cancel(taskId)
    await vi.advanceTimersByTimeAsync(1100)

    expect(rpc.forceRemove).toHaveBeenCalledTimes(1)

    resolveFirstForceRemove('OK')
    await cancelPromise

    expect(rpc.forceRemove).toHaveBeenCalledTimes(1)
  })
})
