import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AppliedDownloadProxyPolicy } from '@core/proxy/applied-download-proxy-policy'
import { DownloadErrorCode } from '@shared/errors'
import type { DownloadTask } from '@shared/types/task'
import {
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Aria2RpcClient } from '../engine/aria2/aria2-rpc-client'
import type { Aria2RawStatus } from '../engine/aria2/types'
import type { EngineAdapter } from '../engine/engine-adapter'
import { DIRECT_RESOURCE_METADATA_PROFILE } from '../engine/engine-adapter'
import { clearStoppedTasks } from '../task/actions/clear-stopped-tasks'
import { stopSeedingTask } from '../task/actions/stop-seeding-task'
import { TaskManager } from '../task/task-manager'
import type {
  MotrixDatabase,
  TaskFileRow,
  TaskInstanceRow,
  TaskRow,
  TaskWithInstances,
} from './motrix-database'
import { SessionManager } from './session-manager'

// ─── Task factory ───────────────────────────────────────────

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

function createTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return makeDownloadTask({
    id: 'motrix-001',
    engineTaskId: 'gid001',
    name: 'test-file.zip',
    progress: 0.5,
    totalBytes: 1000,
    downloadedBytes: 500,
    downloadSpeed: 100,
    etaSeconds: 5,
    saveDir: '/tmp',
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
    uris: ['http://example.com/file.zip'],
    fileCount: 1,
    connections: 1,
    filename: 'test-file.zip',
    sizeWhenDone: 1000,
    ...overrides,
  })
}

// ─── Mock factories ─────────────────────────────────────────

function createMockDb(): MotrixDatabase {
  const tasks = new Map<string, TaskRow>()
  const instances = new Map<string, TaskInstanceRow[]>()
  const fileStore = new Map<string, TaskFileRow[]>()

  const api = {
    init: vi.fn(),
    saveTaskWithInstances: vi.fn((payload: TaskWithInstances) => {
      tasks.set(payload.task.motrixId, payload.task)
      instances.set(payload.task.motrixId, payload.instances)
    }),
    saveTasksBatch: vi.fn((rows: TaskWithInstances[]) => {
      for (const row of rows) {
        tasks.set(row.task.motrixId, row.task)
        instances.set(row.task.motrixId, row.instances)
      }
    }),
    persistTaskWithOccurrence: vi.fn(
      (payload: TaskWithInstances, _occurrence: unknown) => {
        tasks.set(payload.task.motrixId, payload.task)
        instances.set(payload.task.motrixId, payload.instances)
      }
    ),
    getAllTasks: vi.fn(() =>
      [...tasks.values()].map((task) => ({
        task,
        instances: instances.get(task.motrixId) ?? [],
      }))
    ),
    getTask: vi.fn((motrixId: string) => {
      const task = tasks.get(motrixId)
      if (!task) return null
      return { task, instances: instances.get(motrixId) ?? [] }
    }),
    listBridgeTasks: vi.fn(() => [] as TaskWithInstances[]),
    deleteTask: vi.fn((motrixId: string) => {
      tasks.delete(motrixId)
      instances.delete(motrixId)
      fileStore.delete(motrixId)
    }),
    deleteTasks: vi.fn((motrixIds: readonly string[]) => {
      for (const motrixId of motrixIds) {
        tasks.delete(motrixId)
        instances.delete(motrixId)
        fileStore.delete(motrixId)
      }
    }),
    replaceInstances: vi.fn((motrixId: string, rows: TaskInstanceRow[]) => {
      instances.set(motrixId, rows)
    }),
    deleteInstance: vi.fn((instanceId: string) => {
      for (const [motrixId, list] of instances.entries()) {
        instances.set(
          motrixId,
          list.filter((i) => i.instanceId !== instanceId)
        )
      }
    }),
    replaceTaskFiles: vi.fn((motrixId: string, files: TaskFileRow[]) => {
      fileStore.set(motrixId, files)
    }),
    getTaskFiles: vi.fn((motrixId: string) => fileStore.get(motrixId) ?? []),
    close: vi.fn(),
  } as unknown as MotrixDatabase
  return api
}

function createMockRpc(
  opts: { activeTasks?: Aria2RawStatus[] } = {}
): Aria2RpcClient {
  return {
    tellStatus: vi.fn().mockRejectedValue(new Error('tellStatus not mocked')),
    tellActive: vi.fn().mockResolvedValue(opts.activeTasks ?? []),
    tellWaiting: vi.fn().mockResolvedValue([]),
    tellStopped: vi.fn().mockResolvedValue([]),
    multicall: vi.fn().mockResolvedValue([[], [], []]),
  } as unknown as Aria2RpcClient
}

function makeAria2Status(
  overrides: Partial<Aria2RawStatus> = {}
): Aria2RawStatus {
  return {
    gid: 'gid-default',
    status: 'active',
    totalLength: '0',
    completedLength: '0',
    uploadLength: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    connections: '0',
    files: [],
    dir: '/tmp',
    ...overrides,
  } as unknown as Aria2RawStatus
}

function makeTaskRow(motrixId: string, kind: TaskKind): TaskRow {
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

function makeInstanceRow(
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

/**
 * Seed a TaskWithInstances pair into the mock DB using the legacy
 * single-row option bag shape (motrixId + gid + flat task/instance
 * fields). Used by restore tests migrated from the pre-Plan-A
 * TaskMetadata API where seeding was a single saveMetadata call.
 */
function seedAsPair(
  db: MotrixDatabase,
  opts: {
    motrixId: string
    gid: string | null
    name?: string
    kind?: TaskKind
    type?: TaskType
    status?: TaskStatus
    infoHash?: string | null
    torrentMetaPath?: string | null
    uris?: string[]
    uriHash?: string | null
    diskPath?: string
    finalPath?: string
    finalName?: string
    totalBytes?: number
    downloadedBytes?: number
    sizeWhenDone?: number
    uploadedBytes?: number
    uploadedBytesBaseline?: number
    fileCount?: number
    isPrivate?: boolean
    trackers?: string[][]
    pieceLength?: number
    category?: string | null
    priority?: number
    transitionPhase?: TransitionPhase
    createdAt?: number
    updatedAt?: number
    source?: 'user' | 'bridge' | 'plugin'
    finishedAt?: number | null
    errorMessage?: string | null
    errorCode?: DownloadErrorCode | null
    payload?: Record<string, unknown>
  }
): void {
  const isBtLike =
    opts.type === TaskType.Bt ||
    opts.type === TaskType.Magnet ||
    opts.kind === TaskKind.Bt ||
    !!opts.infoHash ||
    !!opts.torrentMetaPath
  const phase = isBtLike
    ? TaskInstancePhase.BtDownload
    : TaskInstancePhase.HttpDownload
  const kind = opts.kind ?? (isBtLike ? TaskKind.Bt : TaskKind.Direct)
  const status = opts.status ?? TaskStatus.Queued
  db.saveTaskWithInstances({
    task: {
      motrixId: opts.motrixId,
      name: opts.name ?? opts.motrixId,
      kind,
      taskType: opts.type ?? (isBtLike ? TaskType.Bt : TaskType.Http),
      category: opts.category ?? null,
      priority: opts.priority ?? 0,
      tags: null,
      createdAt: opts.createdAt ?? 0,
      updatedAt: opts.updatedAt ?? 0,
      finalPath: opts.finalPath ?? '',
      finalName: opts.finalName ?? '',
      torrentMetaPath: opts.torrentMetaPath ?? null,
      infoHash: opts.infoHash ?? null,
      totalBytes: opts.totalBytes ?? 0,
      downloadedBytes: opts.downloadedBytes ?? 0,
      sizeWhenDone: opts.sizeWhenDone ?? opts.totalBytes ?? 0,
      fileCount: opts.fileCount ?? 0,
      isPrivate: opts.isPrivate ?? false,
      trackers: opts.trackers ?? [],
      pieceLength: opts.pieceLength ?? 0,
      aggStatus: status,
      finishedAt: opts.finishedAt ?? null,
      errorMessage: opts.errorMessage ?? null,
      errorCode: opts.errorCode ?? null,
      errorDetailKey: null,
      errorDetailParams: null,
      diagnosisRevision: 0,
      uploadedBytesBaseline: opts.uploadedBytesBaseline ?? 0,
      source: opts.source ?? 'user',
      sourceMeta: null,
    },
    instances: [
      {
        instanceId: `inst:${opts.motrixId}`,
        motrixId: opts.motrixId,
        gid: opts.gid,
        phase,
        status,
        progress: 0,
        totalBytes: opts.totalBytes ?? 0,
        downloadedBytes: opts.downloadedBytes ?? 0,
        uploadedBytes: opts.uploadedBytes ?? 0,
        diskPath: opts.diskPath ?? '',
        transitionPhase: opts.transitionPhase ?? TransitionPhase.Idle,
        uris: opts.uris ?? [],
        uriHash: opts.uriHash ?? null,
        payload: opts.payload ?? {},
        createdAt: opts.createdAt ?? 0,
        updatedAt: opts.updatedAt ?? 0,
      },
    ],
  })
}

function createMockAdapter(): EngineAdapter {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    getCapabilities: vi.fn(),
    getFeatureReport: vi.fn(),
    getDirectResourceMetadataProfile: vi.fn(
      () => DIRECT_RESOURCE_METADATA_PROFILE
    ),
    createDownload: vi.fn(async ({ gid }) => gid ?? 'gid-mock'),
    pauseTask: vi.fn(),
    resumeTask: vi.fn(),
    removeTask: vi.fn(),
    forceRemoveTask: vi.fn(),
    pauseAll: vi.fn(),
    resumeAll: vi.fn(),
    changePosition: vi.fn(),
    getTaskStatus: vi.fn(),
    getTaskFiles: vi.fn(),
    getTaskPieces: vi.fn(),
    getGlobalStats: vi.fn(),
    addTorrent: vi.fn(async ({ gid }) => gid ?? 'gid-mock'),
    removeDownloadResult: vi.fn(),
    getUploadLength: vi.fn(),
    listActiveAndWaiting: vi.fn(async () => []),
    listStopped: vi.fn(async () => []),
    onBtDownloadComplete: vi.fn(),
    onDownloadComplete: vi.fn(),
    onDownloadError: vi.fn(),
  } as unknown as EngineAdapter
}

// ─── Aria2 raw status fixture ───────────────────────────────

function createRawStatus(
  overrides: Partial<Aria2RawStatus> = {}
): Aria2RawStatus {
  return {
    gid: 'gid001',
    status: 'active',
    totalLength: '1000',
    completedLength: '500',
    uploadLength: '0',
    downloadSpeed: '100',
    uploadSpeed: '0',
    connections: '1',
    numSeeders: '0',
    seeder: 'false',
    pieceLength: '1000',
    numPieces: '1',
    dir: '/tmp',
    files: [
      {
        index: '1',
        path: '/tmp/test-file.zip',
        length: '1000',
        completedLength: '500',
        selected: 'true',
        uris: [
          {
            uri: 'http://example.com/file.zip',
            status: 'used',
          },
        ],
      },
    ],
    ...overrides,
  }
}

function makeRawStatus(overrides: Partial<Aria2RawStatus>): Aria2RawStatus {
  return {
    gid: 'gid-default',
    status: 'active',
    totalLength: '0',
    completedLength: '0',
    uploadLength: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    connections: '0',
    files: [],
    dir: '/tmp',
    ...overrides,
  } as unknown as Aria2RawStatus
}

function makeMultiInstanceTask(): DownloadTask {
  return makeDownloadTask({
    id: 'm-multi',
    engineTaskId: 'g-seg-0',
    name: 'video.mp4',
    kind: TaskKind.Hls,
    totalBytes: 1000,
    saveDir: '/Downloads',
    createdAt: 1700000000,
    updatedAt: 1700000001,
    fileCount: 1,
    filename: 'video.mp4',
    sizeWhenDone: 1000,
    source: 'bridge',
    diskPath: '/tmp',
    finalPath: '/Downloads',
    finalName: 'video.mp4',
    instances: [
      {
        instanceId: 'i-seg-0',
        motrixId: 'm-multi',
        gid: 'g-seg-0',
        phase: TaskInstancePhase.HlsSegment,
        status: TaskStatus.Downloading,
        progress: 0,
        totalBytes: 500,
        downloadedBytes: 0,
        uploadedBytes: 0,
        diskPath: '/tmp',
        transitionPhase: TransitionPhase.Idle,
        uris: ['https://hls.example.com/segment0.ts'],
        uriHash: 'hash-0',
        payload: { segmentIndex: 0 },
        createdAt: 1700000000,
        updatedAt: 1700000001,
      },
      {
        instanceId: 'i-mux',
        motrixId: 'm-multi',
        gid: null,
        phase: TaskInstancePhase.FfmpegMux,
        status: TaskStatus.Queued,
        progress: 0,
        totalBytes: 0,
        downloadedBytes: 0,
        uploadedBytes: 0,
        diskPath: '/tmp',
        transitionPhase: TransitionPhase.Idle,
        uris: [],
        uriHash: null,
        payload: {},
        createdAt: 1700000000,
        updatedAt: 1700000001,
      },
    ],
  })
}

// ─── Tests ──────────────────────────────────────────────────

describe('SessionManager', () => {
  let taskManager: TaskManager
  let rpc: Aria2RpcClient
  let db: MotrixDatabase
  let adapter: EngineAdapter
  let session: SessionManager

  beforeEach(() => {
    vi.useFakeTimers()
    taskManager = new TaskManager()
    rpc = createMockRpc()
    db = createMockDb()
    adapter = createMockAdapter()
    session = new SessionManager(taskManager, rpc, db, adapter)
  })

  afterEach(() => {
    session.stopAutoSave()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('save', () => {
    it('saves non-removed tasks to database', async () => {
      const task1 = createTask({
        id: 'motrix-001',
        engineTaskId: 'gid001',
        status: TaskStatus.Downloading,
      })
      const task2 = createTask({
        id: 'motrix-002',
        engineTaskId: 'gid002',
        status: TaskStatus.Completed,
      })
      const task3 = createTask({
        id: 'motrix-003',
        engineTaskId: 'gid003',
        status: TaskStatus.Removed,
      })

      taskManager.set(task1.id, task1)
      taskManager.set(task2.id, task2)
      taskManager.set(task3.id, task3)

      await session.save()

      // Should save task1 and task2 via batch, but NOT task3 (removed)
      expect(db.saveTasksBatch).toHaveBeenCalledTimes(1)
      const batchArg = vi.mocked(db.saveTasksBatch).mock.calls[0][0]
      expect(batchArg).toHaveLength(2)
      expect(batchArg.map((p) => p.task.motrixId).sort()).toEqual([
        'motrix-001',
        'motrix-002',
      ])
      // Each saved pair carries a synthesized primary instance whose
      // gid matches engineTaskId (Task 6: synthesizePrimaryInstance).
      const byMotrixId = new Map(batchArg.map((p) => [p.task.motrixId, p]))
      expect(byMotrixId.get('motrix-001')?.instances[0]?.gid).toBe('gid001')
      expect(byMotrixId.get('motrix-002')?.instances[0]?.gid).toBe('gid002')
    })

    it('persists an unpublished candidate without reading or mutating TaskManager', async () => {
      const current = createTask({
        id: 'candidate-task',
        status: TaskStatus.Downloading,
      })
      const candidate = {
        ...current,
        status: TaskStatus.Paused,
        updatedAt: current.updatedAt + 1,
      }
      taskManager.set(current.id, current)

      await session.persistTask(candidate)

      expect(taskManager.getById(current.id)?.status).toBe(
        TaskStatus.Downloading
      )
      expect(db.getTask(current.id)?.task.aggStatus).toBe(TaskStatus.Paused)
    })

    it('stop seeding persists Completed before success and survives restart', async () => {
      const seeding = createTask({
        id: 'm-seeding',
        engineTaskId: 'g-seeding',
        kind: TaskKind.Bt,
        type: TaskType.Bt,
        status: TaskStatus.Seeding,
        instances: [
          {
            ...makeInstanceRow(
              'i-seeding',
              'm-seeding',
              'g-seeding',
              TaskInstancePhase.BtDownload
            ),
            status: TaskStatus.Seeding,
          },
        ],
      })
      taskManager.set(seeding.id, seeding)
      const forceRemoveTask = vi.fn().mockResolvedValue(undefined)
      ;(
        adapter as unknown as {
          forceRemoveTask: typeof forceRemoveTask
        }
      ).forceRemoveTask = forceRemoveTask
      // aria2 commonly retains a short-lived removed result after
      // forceRemove. The domain transition must still persist Completed and
      // survive restart.
      adapter.getTaskStatus = vi
        .fn()
        .mockResolvedValue({ status: TaskStatus.Removed } as never)
      const eventBus = { emit: vi.fn() }

      await stopSeedingTask(seeding.id, {
        taskManager,
        adapter,
        eventBus,
        log: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        persist: (candidate: DownloadTask) => session.persistTask(candidate),
        publishTaskUpdate: vi.fn(),
        publishTaskUpdateNow: vi.fn(),
      } as never)

      expect(adapter.getTaskStatus).not.toHaveBeenCalled()
      const persisted = db.getTask(seeding.id)
      expect(persisted?.task).toMatchObject({
        aggStatus: TaskStatus.Completed,
        finishedAt: expect.any(Number),
      })
      expect(persisted?.instances[0].status).toBe(TaskStatus.Completed)

      const restartedTasks = new TaskManager()
      const restarted = new SessionManager(
        restartedTasks,
        rpc,
        db,
        createMockAdapter()
      )
      await restarted.restore()

      expect(restartedTasks.getById(seeding.id)).toMatchObject({
        status: TaskStatus.Completed,
        finishedAt: persisted?.task.finishedAt,
      })
    })

    it('skips save when no tasks', async () => {
      await session.save()
      expect(db.saveTasksBatch).toHaveBeenCalledWith([])
    })

    it('persists info_hash for BT tasks with infoHash set', async () => {
      const task = createTask({
        type: TaskType.Bt,
        infoHash: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
        uris: [],
      })
      taskManager.add(task)
      await session.save()
      const saved = db.getTask(task.id)
      expect(saved?.task.infoHash).toBe(
        'aaaa1111bbbb2222cccc3333dddd4444eeee5555'
      )
      expect(saved?.instances[0]?.uriHash).toBeNull()
    })

    it('persists uri_hash for HTTP tasks', async () => {
      const task = createTask({
        type: TaskType.Http,
        infoHash: null,
        uris: ['http://example.com/file.zip'],
      })
      taskManager.add(task)
      await session.save()
      const saved = db.getTask(task.id)
      expect(saved?.instances[0]?.uriHash).toMatch(/^[0-9a-f]{16}$/)
      expect(saved?.task.infoHash).toBeNull()
    })

    it('uri_hash is stable when uris reorder', async () => {
      const taskA = createTask({
        id: 'm-a',
        engineTaskId: 'gid-a',
        type: TaskType.Http,
        uris: ['http://a/f.zip', 'http://b/f.zip'],
      })
      const taskB = createTask({
        id: 'm-b',
        engineTaskId: 'gid-b',
        type: TaskType.Http,
        uris: ['http://b/f.zip', 'http://a/f.zip'],
      })
      taskManager.add(taskA)
      taskManager.add(taskB)
      await session.save()
      expect(db.getTask('m-a')?.instances[0]?.uriHash).toBe(
        db.getTask('m-b')?.instances[0]?.uriHash
      )
    })

    it('persists uris on save', async () => {
      const task = createTask({
        type: TaskType.Http,
        uris: ['http://example.com/a.zip', 'http://mirror.com/a.zip'],
      })
      taskManager.add(task)
      await session.save()
      const saved = db.getTask(task.id)
      expect(saved?.instances[0]?.uris).toEqual([
        'http://example.com/a.zip',
        'http://mirror.com/a.zip',
      ])
    })

    it('persists mirror columns', async () => {
      const task = createTask({
        id: 'm-mirror',
        engineTaskId: 'gid-mirror',
        totalBytes: 1024,
        downloadedBytes: 512,
        sizeWhenDone: 1024,
        uploadedBytes: 256,
        uploadedBytesBaseline: 0,
        fileCount: 3,
        pieceLength: 256,
      })
      taskManager.add(task)
      await session.save()
      const saved = db.getTask('m-mirror')
      expect(saved?.task.totalBytes).toBe(1024)
      expect(saved?.task.downloadedBytes).toBe(512)
      expect(saved?.task.sizeWhenDone).toBe(1024)
      expect(saved?.instances[0]?.uploadedBytes).toBe(256)
      expect(saved?.task.fileCount).toBe(3)
      expect(saved?.task.pieceLength).toBe(256)
    })

    it('preserves isPrivate=true across save (round-trip)', async () => {
      const task = createTask({
        id: 'm-bt-private',
        engineTaskId: 'gid-bt-private',
        type: TaskType.Bt,
        infoHash: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
        uris: [],
        bt: {
          peers: 3,
          seeds: 2,
          ratio: 0.5,
          trackers: [],
          selectedFiles: [],
          peersInSwarm: 10,
          seedsInSwarm: 5,
          announceList: [],
          comment: null,
          isPrivate: true,
          magnetUri: null,
          sequentialDownload: false,
        },
      })
      taskManager.add(task)
      await session.save()
      const saved = db.getTask('m-bt-private')
      expect(saved?.task.isPrivate).toBe(true)
    })

    it('persists DownloadTask.instances when supplied (multi-instance HLS task)', async () => {
      const task = makeMultiInstanceTask()
      taskManager.set('m-multi', task)
      await session.save()

      const saved = db.getTask('m-multi')
      expect(saved).not.toBeNull()
      expect(saved?.instances).toHaveLength(2)
      expect(saved?.instances.map((i) => i.phase).sort()).toEqual([
        TaskInstancePhase.FfmpegMux,
        TaskInstancePhase.HlsSegment,
      ])
    })
  })

  describe('exclusive persistence queue', () => {
    it('runs operations FIFO and recovers after a rejected operation', async () => {
      const order: string[] = []
      let releaseFirst: (() => void) | undefined
      const first = session.runExclusivePersistence(
        () =>
          new Promise<void>((resolve) => {
            order.push('first:start')
            releaseFirst = () => {
              order.push('first:end')
              resolve()
            }
          })
      )
      const second = session.runExclusivePersistence(() => {
        order.push('second')
      })

      await Promise.resolve()
      expect(order).toEqual(['first:start'])
      releaseFirst?.()
      await Promise.all([first, second])
      expect(order).toEqual(['first:start', 'first:end', 'second'])

      await expect(
        session.runExclusivePersistence(() => {
          throw new Error('write failed')
        })
      ).rejects.toThrow('write failed')
      await expect(
        session.runExclusivePersistence(() => {
          order.push('after-error')
          return 42
        })
      ).resolves.toBe(42)
      expect(order.at(-1)).toBe('after-error')
    })

    it('captures the TaskManager snapshot only when the queued save begins', async () => {
      let releaseBlocker: (() => void) | undefined
      const blocker = session.runExclusivePersistence(
        () =>
          new Promise<void>((resolve) => {
            releaseBlocker = resolve
          })
      )
      await Promise.resolve()

      const task = createTask({ id: 'queued-save' })
      taskManager.add(task)
      const queuedSave = session.save()
      taskManager.remove(task.id)

      releaseBlocker?.()
      await blocker
      await queuedSave

      expect(db.saveTasksBatch).toHaveBeenCalledWith([])
    })

    it('orders save and Clear Stopped without resurrecting deleted rows', async () => {
      const terminal = createTask({
        id: 'clear-race',
        engineTaskId: 'gid-clear-race',
        status: TaskStatus.Completed,
        finishedAt: 123,
      })
      taskManager.add(terminal)
      await session.save()
      expect(db.getTask(terminal.id)).not.toBeNull()

      let releaseBlocker: (() => void) | undefined
      const blocker = session.runExclusivePersistence(
        () =>
          new Promise<void>((resolve) => {
            releaseBlocker = resolve
          })
      )
      await Promise.resolve()

      // This save captures its snapshot only after the blocker. Clear Stopped
      // queues behind it, so the old save may commit first but deletion is
      // guaranteed to commit last.
      const oldSave = session.save()
      const clear = clearStoppedTasks({
        taskManager,
        adapter: {
          removeDownloadResults: vi
            .fn()
            .mockImplementation(async (gids: readonly string[]) =>
              gids.map(() => ({
                status: 'fulfilled' as const,
                value: undefined,
              }))
            ),
        },
        db,
        taskPersistence: session,
        eventBus: { emit: vi.fn() },
        log: { info: vi.fn(), warn: vi.fn() },
        publishTaskUpdateNow: vi.fn(),
      })

      releaseBlocker?.()
      await Promise.all([blocker, oldSave, clear])

      expect(taskManager.getById(terminal.id)).toBeUndefined()
      expect(db.getTask(terminal.id)).toBeNull()

      // A later queued save sees post-clear memory and cannot recreate it.
      await session.save()
      expect(db.getTask(terminal.id)).toBeNull()
    })
  })

  describe('restore — reconcile: aria2 exists, saved missing (adopt)', () => {
    it('adopts orphan aria2 tasks', async () => {
      // db is already empty by default via the shared beforeEach.
      // aria2 has a task Motrix doesn't know about
      vi.mocked(rpc.tellActive).mockResolvedValue([
        createRawStatus({
          gid: 'gid-orphan',
          status: 'active',
        }),
      ])

      await session.restore()

      // TaskManager should have a new task
      const tasks = taskManager.getAll()
      expect(tasks).toHaveLength(1)
      expect(tasks[0].engineTaskId).toBe('gid-orphan')
      // Adopted task gets a new Motrix ID (not matching any saved)
      expect(tasks[0].id).not.toBe('gid-orphan')
    })

    it('does NOT adopt aria2 segment downloads under mediaTmpRoot (phantom-task guard)', async () => {
      // A mux/hls/dash task's segment downloads run on the shared aria2 daemon
      // and persist in aria2's session. On restart aria2 restores them; without
      // the guard restore() would adopt each as a phantom "000000.seg" task.
      const mediaRoot = '/var/tmp/motrix-media'
      const mediaSession = new SessionManager(
        taskManager,
        rpc,
        db,
        adapter,
        mediaRoot
      )
      vi.mocked(rpc.tellActive).mockResolvedValue([
        createRawStatus({
          gid: 'seg-video',
          status: 'active',
          dir: `${mediaRoot}/motrix-media-abc123/video`,
        }),
        createRawStatus({
          gid: 'seg-audio',
          status: 'complete',
          dir: `${mediaRoot}/motrix-media-abc123/audio`,
        }),
      ])

      await mediaSession.restore()

      expect(taskManager.getAll()).toHaveLength(0)
    })

    it('still adopts a normal download whose dir is outside mediaTmpRoot', async () => {
      const mediaRoot = '/var/tmp/motrix-media'
      const mediaSession = new SessionManager(
        taskManager,
        rpc,
        db,
        adapter,
        mediaRoot
      )
      vi.mocked(rpc.tellActive).mockResolvedValue([
        createRawStatus({
          gid: 'normal-gid',
          status: 'active',
          dir: '/Users/me/Downloads',
        }),
      ])

      await mediaSession.restore()

      const tasks = taskManager.getAll()
      expect(tasks).toHaveLength(1)
      expect(tasks[0].engineTaskId).toBe('normal-gid')
    })
  })

  describe('auto-save', () => {
    it('does not auto-save while the engine is idle', async () => {
      const task = createTask()
      taskManager.set(task.id, task)

      // startAutoSave only configures the interval; the engine defaults to
      // idle, so the timer must not arm — no rewriting the history while
      // nothing is downloading.
      session.startAutoSave(60_000)

      await vi.advanceTimersByTimeAsync(120_000)
      expect(db.saveTasksBatch).not.toHaveBeenCalled()
    })

    it('auto-saves periodically while the engine is active', async () => {
      const task = createTask()
      taskManager.set(task.id, task)

      session.startAutoSave(60_000)
      session.setEngineActive(true)

      await vi.advanceTimersByTimeAsync(60_000)
      expect(db.saveTasksBatch).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(60_000)
      expect(db.saveTasksBatch).toHaveBeenCalledTimes(2)
    })

    it('flushes once and stops auto-saving when the engine goes idle', async () => {
      const task = createTask()
      taskManager.set(task.id, task)

      session.startAutoSave(60_000)
      session.setEngineActive(true)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(db.saveTasksBatch).toHaveBeenCalledTimes(1)

      // active→idle: one final flush so the last mirror is durable, then stop.
      session.setEngineActive(false)
      await vi.advanceTimersByTimeAsync(0)
      expect(db.saveTasksBatch).toHaveBeenCalledTimes(2)

      // Timer is stopped — no further periodic saves while idle.
      await vi.advanceTimersByTimeAsync(120_000)
      expect(db.saveTasksBatch).toHaveBeenCalledTimes(2)
    })

    it('stopAutoSave clears the timer', async () => {
      const task = createTask()
      taskManager.set(task.id, task)

      session.startAutoSave(60_000)
      session.setEngineActive(true)
      session.stopAutoSave()

      await vi.advanceTimersByTimeAsync(120_000)
      expect(db.saveTasksBatch).not.toHaveBeenCalled()
    })

    it('save() still flushes while idle — only the timer is gated', async () => {
      // The engine-idle gate stops the periodic *timer*, not explicit save().
      // performCleanup (app quit) and requestSave (discrete changes) call
      // save() directly, so they must persist regardless of engine activity —
      // otherwise quitting while idle, or deleting/completing a task, could
      // lose state.
      const task = createTask()
      taskManager.set(task.id, task)
      session.setEngineActive(false)

      await session.save()
      expect(db.saveTasksBatch).toHaveBeenCalledTimes(1)
    })
  })

  describe('requestSave (coalescing)', () => {
    it('collapses N rapid calls into a single save', async () => {
      const task = createTask()
      taskManager.set(task.id, task)

      // Five callers all kick off at t=0; with a 50ms debounce they
      // should all settle on the same save invocation.
      const promises = [
        session.requestSave(),
        session.requestSave(),
        session.requestSave(),
        session.requestSave(),
        session.requestSave(),
      ]

      // Nothing should have hit the DB yet — debounce hasn't expired.
      expect(db.saveTasksBatch).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(50)
      await Promise.all(promises)

      expect(db.saveTasksBatch).toHaveBeenCalledTimes(1)
    })

    it('opens a fresh window after the previous save settles', async () => {
      const task = createTask()
      taskManager.set(task.id, task)

      const first = session.requestSave()
      await vi.advanceTimersByTimeAsync(50)
      await first
      expect(db.saveTasksBatch).toHaveBeenCalledTimes(1)

      const second = session.requestSave()
      await vi.advanceTimersByTimeAsync(50)
      await second
      expect(db.saveTasksBatch).toHaveBeenCalledTimes(2)
    })

    it('returned promise resolves only after the underlying save runs', async () => {
      const task = createTask()
      taskManager.set(task.id, task)

      let resolved = false
      const p = session.requestSave().then(() => {
        resolved = true
      })

      // Mid-window: still pending.
      await vi.advanceTimersByTimeAsync(40)
      // Flush any queued microtasks so the assertion sees current state.
      await Promise.resolve()
      expect(resolved).toBe(false)
      expect(db.saveTasksBatch).not.toHaveBeenCalled()

      // Cross the debounce boundary; save fires and the promise settles.
      await vi.advanceTimersByTimeAsync(20)
      await p
      expect(resolved).toBe(true)
      expect(db.saveTasksBatch).toHaveBeenCalledTimes(1)
    })

    it('still resolves callers if the underlying save throws', async () => {
      const task = createTask()
      taskManager.set(task.id, task)
      ;(db.saveTasksBatch as ReturnType<typeof vi.fn>).mockImplementationOnce(
        () => {
          throw new Error('disk full')
        }
      )

      const p = session.requestSave()
      await vi.advanceTimersByTimeAsync(50)
      // Must not reject — caller already chose fire-and-forget semantics
      // by using requestSave; rejecting would surface as unhandled.
      await expect(p).resolves.toBeUndefined()
    })

    it('stopAndDrain cancels debounce, performs one final queued save, and gates later saves', async () => {
      const task = createTask()
      taskManager.set(task.id, task)
      const pending = session.requestSave()

      const drain = session.stopAndDrain()
      expect(session.stopAndDrain()).toBe(drain)
      await drain
      await pending

      expect(db.saveTasksBatch).toHaveBeenCalledTimes(1)

      await session.requestSave()
      await session.save()
      await vi.advanceTimersByTimeAsync(100)
      expect(db.saveTasksBatch).toHaveBeenCalledTimes(1)
    })

    it('rejects hard persistence and exclusive operations accepted after stop', async () => {
      const task = createTask({ id: 'late-hard-write' })
      taskManager.set(task.id, task)
      await session.stopAndDrain()
      const operation = vi.fn()

      await expect(session.persistTask(task)).rejects.toThrow(/stopping/i)
      await expect(session.saveTask(task.id)).rejects.toThrow(/stopping/i)
      await expect(session.runExclusivePersistence(operation)).rejects.toThrow(
        /stopping/i
      )

      expect(operation).not.toHaveBeenCalled()
    })
  })

  describe('restore (content-addressed)', () => {
    let taskManager: TaskManager
    let rpc: Aria2RpcClient
    let db: MotrixDatabase
    let adapter: EngineAdapter
    let sessionManager: SessionManager

    beforeEach(() => {
      taskManager = new TaskManager()
      rpc = createMockRpc()
      db = createMockDb()
      adapter = createMockAdapter()
      sessionManager = new SessionManager(taskManager, rpc, db, adapter)
    })

    it('MERGES BT task by info_hash even when gids differ', async () => {
      const savedGid = 'old-gid-001'
      const newGid = 'new-gid-001'
      const infoHash = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555'

      seedAsPair(db, {
        motrixId: 'm-bt-001',
        gid: savedGid,
        name: 'ubuntu.iso',
        category: null,
        priority: 0,
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
        diskPath: '/tmp/ubuntu.iso.motrix',
        finalPath: '/tmp/ubuntu.iso',
        finalName: 'ubuntu.iso',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: '/tmp/ubuntu.torrent',
        infoHash,
        uriHash: null,
        uris: [],
        status: TaskStatus.Downloading,
      })

      rpc.tellActive = vi.fn(async () => [
        makeRawStatus({ gid: newGid, infoHash, status: 'active' }),
      ])
      rpc.tellWaiting = vi.fn(async () => [])
      rpc.tellStopped = vi.fn(async () => [])

      await sessionManager.restore()

      const restored = taskManager.getAll().find((t) => t.id === 'm-bt-001')
      expect(restored).toBeDefined()
      expect(restored?.engineTaskId).toBe(newGid)
      expect(restored?.status).not.toBe(TaskStatus.Error)
    })

    it('preserves BT type when aria2 omits the bittorrent field', async () => {
      // Repro for the post-restart "BT becomes HTTP" symptom: aria2
      // restores the task into reservedGroups_ as state="waiting"
      // before parsing the .torrent, so tellWaiting reports the gid
      // with NO `bittorrent` block. Without the sidecar fallback, the
      // renderer would render this row as an HTTP task forever (the
      // poll loop's mergeEngineTask spreads `existing` first and
      // never recomputes type).
      const gid = 'bt-not-yet-parsed-001'
      const infoHash = '1111222233334444555566667777888899990000'

      seedAsPair(db, {
        motrixId: 'm-bt-type-001',
        gid,
        name: 'ubuntu.iso',
        category: null,
        priority: 0,
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
        diskPath: '/tmp/ubuntu.iso',
        finalPath: '/tmp/ubuntu.iso',
        finalName: 'ubuntu.iso',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: '/tmp/ubuntu.torrent',
        infoHash,
        uriHash: null,
        uris: [],
        status: TaskStatus.Seeding,
        isPrivate: true,
      })

      // Crucial: NO `bittorrent` field, NO `infoHash` on the raw —
      // mirrors what aria2 returns for a freshly-restored
      // reservedGroup whose .torrent hasn't been read yet.
      rpc.tellActive = vi.fn(async () => [])
      rpc.tellWaiting = vi.fn(async () => [
        makeRawStatus({
          gid,
          status: 'waiting',
          // no bittorrent, no infoHash
        }),
      ])
      rpc.tellStopped = vi.fn(async () => [])

      await sessionManager.restore()

      const restored = taskManager
        .getAll()
        .find((t) => t.id === 'm-bt-type-001')
      expect(restored).toBeDefined()
      expect(restored?.type).toBe(TaskType.Bt)
      expect(restored?.infoHash).toBe(infoHash)
      expect(restored?.bt).toBeDefined()
      expect(restored?.bt?.isPrivate).toBe(true)
    })

    it('MERGES fork-restored task by gid when content keys are unavailable', async () => {
      seedAsPair(db, {
        motrixId: 'm-same-gid',
        gid: 'same-gid-paused',
        name: 'ubuntu.iso',
        category: null,
        priority: 0,
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
        diskPath: '/tmp/ubuntu.iso.motrix',
        finalPath: '/tmp/ubuntu.iso',
        finalName: 'ubuntu.iso',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: null,
        infoHash: null,
        uriHash: null,
        uris: [],
        status: TaskStatus.Paused,
      })

      rpc.tellActive = vi.fn(async () => [])
      rpc.tellWaiting = vi.fn(async () => [
        makeRawStatus({ gid: 'same-gid-paused', status: 'paused' }),
      ])
      rpc.tellStopped = vi.fn(async () => [])

      await sessionManager.restore()

      expect(adapter.addTorrent).not.toHaveBeenCalled()
      expect(adapter.createDownload).not.toHaveBeenCalled()
      const restored = taskManager.getAll().find((t) => t.id === 'm-same-gid')
      expect(restored?.engineTaskId).toBe('same-gid-paused')
      expect(restored?.status).toBe(TaskStatus.Paused)
      expect(restored?.errorMessage).toBeNull()
    })

    it('re-adds BT task via adapter.addTorrent when aria2 has lost it', async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'motrix-restore-bt-')
      )
      const torrentPath = path.join(tmpDir, 't.torrent')
      fs.writeFileSync(
        torrentPath,
        Buffer.from('d4:infod4:name1:f12:piece lengthi1e6:pieces3:abcee')
      )

      seedAsPair(db, {
        motrixId: 'm-bt-002',
        gid: 'lost-gid',
        name: 't.torrent',
        category: null,
        priority: 0,
        createdAt: 0,
        updatedAt: 0,
        diskPath: '/tmp/t.motrix',
        finalPath: '/tmp/t',
        finalName: 't',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: torrentPath,
        infoHash: null,
        uriHash: null,
        uris: [],
        status: TaskStatus.Downloading,
      })

      rpc.tellActive = vi.fn(async () => [])
      rpc.tellWaiting = vi.fn(async () => [])
      rpc.tellStopped = vi.fn(async () => [])
      ;(adapter.addTorrent as ReturnType<typeof vi.fn>).mockImplementation(
        async ({ gid }: { gid?: string }) => gid ?? ''
      )

      await sessionManager.restore()

      expect(adapter.addTorrent).toHaveBeenCalledTimes(1)
      // Defense against errorCode=13: the reAdd path must hand
      // checkIntegrity:true to aria2 so the legacy "file exists but
      // control file does not" guard is bypassed in favour of a
      // hash-check resume.
      expect(adapter.addTorrent).toHaveBeenCalledWith(
        expect.objectContaining({ checkIntegrity: true })
      )
      const restoreParams = (adapter.addTorrent as ReturnType<typeof vi.fn>)
        .mock.calls[0][0]
      expect(restoreParams).not.toHaveProperty('prioritizePreviewPieces')
      const restored = taskManager.getAll().find((t) => t.id === 'm-bt-002')
      expect(restored?.engineTaskId).toMatch(/^[0-9a-f]{16}$/)
      expect(restored?.engineTaskId).not.toBe('lost-gid')
      expect(restored?.status).not.toBe(TaskStatus.Error)

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('restores preview piece priority for a lost video-only BT task', async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'motrix-restore-video-bt-')
      )
      const torrentPath = path.join(tmpDir, 'video.torrent')
      fs.writeFileSync(torrentPath, buildSingleFileTorrent('Movie.MP4'))

      seedAsPair(db, {
        motrixId: 'm-bt-video',
        gid: 'lost-video-gid',
        name: 'Movie.MP4',
        diskPath: '/tmp/Movie.MP4.motrix',
        finalPath: '/tmp/Movie.MP4',
        finalName: 'Movie.MP4',
        torrentMetaPath: torrentPath,
        status: TaskStatus.Downloading,
      })
      rpc.tellActive = vi.fn(async () => [])
      rpc.tellWaiting = vi.fn(async () => [])
      rpc.tellStopped = vi.fn(async () => [])
      ;(adapter.addTorrent as ReturnType<typeof vi.fn>).mockImplementation(
        async ({ gid }: { gid?: string }) => gid ?? ''
      )

      try {
        await sessionManager.restore()

        expect(adapter.addTorrent).toHaveBeenCalledWith(
          expect.objectContaining({ prioritizePreviewPieces: true })
        )
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('adoptByMetadata derives progress from saved mirror columns', async () => {
      // Regression: paused tasks restored via the reAdd path (aria2 lost
      // the gid) had progress hardcoded to 0 even though totalBytes /
      // downloadedBytes were correctly seeded from the mirror. Overview
      // tab + TaskRow progress bar showed 0% as a result.
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'motrix-restore-progress-')
      )
      const torrentPath = path.join(tmpDir, 't.torrent')
      fs.writeFileSync(
        torrentPath,
        Buffer.from('d4:infod4:name1:f12:piece lengthi1e6:pieces3:abcee')
      )

      seedAsPair(db, {
        motrixId: 'm-bt-progress',
        gid: 'lost-gid-progress',
        name: 't.torrent',
        category: null,
        priority: 0,
        createdAt: 0,
        updatedAt: 0,
        diskPath: '/tmp/t.motrix',
        finalPath: '/tmp/t',
        finalName: 't',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: torrentPath,
        infoHash: null,
        uriHash: null,
        uris: [],
        status: TaskStatus.Paused,
        totalBytes: 1000,
        downloadedBytes: 250,
        sizeWhenDone: 1000,
        uploadedBytes: 100,
        uploadedBytesBaseline: 0,
        fileCount: 1,
      })

      rpc.tellActive = vi.fn(async () => [])
      rpc.tellWaiting = vi.fn(async () => [])
      rpc.tellStopped = vi.fn(async () => [])
      ;(adapter.addTorrent as ReturnType<typeof vi.fn>).mockImplementation(
        async ({ gid }: { gid?: string }) => gid ?? ''
      )

      await sessionManager.restore()

      const restored = taskManager
        .getAll()
        .find((t) => t.id === 'm-bt-progress')
      expect(restored).toBeDefined()
      expect(restored?.totalBytes).toBe(1000)
      expect(restored?.downloadedBytes).toBe(250)
      // 250 / 1000 = 0.25 — derived from saved mirror, not hardcoded 0.
      expect(restored?.progress).toBe(0.25)

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('does NOT reAdd when aria2 has the gid (sqlite-persistence intact)', async () => {
      // This is the crucial regression: motrix.db says gid X is paused;
      // aria2 has gid X loaded (fork's Sqlite3SessionStore did its job).
      // motrix-turbo MUST adopt aria2's task, not call addTorrent — that
      // path is exactly what produces user-reported errorCode=13 collisions.
      const gid = 'sticky-gid-007'

      seedAsPair(db, {
        motrixId: 'm-bt-007',
        gid,
        name: 'ubuntu.iso',
        category: null,
        priority: 0,
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
        diskPath: '/tmp/ubuntu.iso.motrix',
        finalPath: '/tmp/ubuntu.iso',
        finalName: 'ubuntu.iso',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: '/tmp/ubuntu.torrent',
        infoHash: null,
        uriHash: null,
        uris: [],
        status: TaskStatus.Paused,
      })

      rpc.tellActive = vi.fn(async () => [])
      rpc.tellWaiting = vi.fn(async () => [
        makeRawStatus({ gid, status: 'paused' }),
      ])
      rpc.tellStopped = vi.fn(async () => [])

      await sessionManager.restore()

      expect(adapter.addTorrent).not.toHaveBeenCalled()
      expect(adapter.createDownload).not.toHaveBeenCalled()
      const restored = taskManager.getAll().find((t) => t.id === 'm-bt-007')
      expect(restored?.engineTaskId).toBe(gid)
      expect(restored?.status).toBe(TaskStatus.Paused)
    })

    it('prefers a paused live row over a stale stopped error with the same gid', async () => {
      const gid = 'gid-http-paused-with-stale-error'
      const totalBytes = 6_976_131_072
      const downloadedBytes = 2_654_994_432

      seedAsPair(db, {
        motrixId: 'm-http-paused-with-stale-error',
        gid,
        name: 'deepin.iso',
        type: TaskType.Http,
        kind: TaskKind.Direct,
        status: TaskStatus.Paused,
        totalBytes,
        downloadedBytes,
        pieceLength: 1_048_576,
        uris: ['https://example.com/deepin.iso'],
        diskPath: '/tmp/deepin.iso.motrix',
        finalPath: '/tmp/deepin.iso',
        finalName: 'deepin.iso',
      })

      // A just-restored paused row may not materialize its control data until
      // unpaused, so it reports zero metrics. motrix.db still has the last
      // good 38% snapshot.
      rpc.tellWaiting = vi.fn(async () => [
        makeRawStatus({
          gid,
          status: 'paused',
          totalLength: '0',
          completedLength: '0',
        }),
      ])
      // aria2's history store retains an older failure for the same GID. It
      // must not overwrite the current paused lifecycle row or its progress.
      rpc.tellStopped = vi.fn(async () => [
        makeRawStatus({
          gid,
          status: 'error',
          errorCode: '7',
          totalLength: String(totalBytes),
          completedLength: '189513728',
        }),
      ])
      rpc.tellStatus = vi.fn(async () =>
        makeRawStatus({
          gid,
          status: 'paused',
          totalLength: '0',
          completedLength: '0',
        })
      )

      await sessionManager.restore()

      const restored = taskManager.getById('m-http-paused-with-stale-error')
      expect(restored).toMatchObject({
        engineTaskId: gid,
        status: TaskStatus.Paused,
        totalBytes,
        downloadedBytes,
      })
      expect(restored?.progress).toBeCloseTo(downloadedBytes / totalBytes)
      expect(db.persistTaskWithOccurrence).not.toHaveBeenCalled()
      expect(adapter.forceRemoveTask).not.toHaveBeenCalled()
      expect(adapter.removeDownloadResult).not.toHaveBeenCalled()
      expect(rpc.tellStatus).toHaveBeenCalledExactlyOnceWith(gid)
    })

    it('keeps active when tellStatus confirms it over duplicate waiting and stopped rows', async () => {
      const gid = 'gid-active-wins-all-duplicates'
      seedAsPair(db, {
        motrixId: 'm-active-wins-all-duplicates',
        gid,
        status: TaskStatus.Downloading,
        totalBytes: 1000,
        downloadedBytes: 500,
      })
      rpc.tellActive = vi.fn(async () => [
        makeRawStatus({
          gid,
          status: 'active',
          totalLength: '1000',
          completedLength: '700',
        }),
      ])
      rpc.tellWaiting = vi.fn(async () => [
        makeRawStatus({
          gid,
          status: 'paused',
          totalLength: '1000',
          completedLength: '600',
        }),
      ])
      rpc.tellStopped = vi.fn(async () => [
        makeRawStatus({
          gid,
          status: 'complete',
          totalLength: '1000',
          completedLength: '1000',
        }),
      ])
      rpc.tellStatus = vi.fn(async () =>
        makeRawStatus({
          gid,
          status: 'active',
          totalLength: '1000',
          completedLength: '700',
        })
      )

      await sessionManager.restore()

      expect(taskManager.getById('m-active-wins-all-duplicates')).toMatchObject(
        {
          status: TaskStatus.Downloading,
          totalBytes: 1000,
          downloadedBytes: 700,
          progress: 0.7,
        }
      )
      expect(db.persistTaskWithOccurrence).not.toHaveBeenCalled()
      expect(rpc.tellStatus).toHaveBeenCalledExactlyOnceWith(gid)
    })

    it('falls back to the live row when duplicate-GID arbitration fails', async () => {
      const gid = 'gid-duplicate-arbitration-failed'
      seedAsPair(db, {
        motrixId: 'm-duplicate-arbitration-failed',
        gid,
        status: TaskStatus.Paused,
        totalBytes: 1000,
        downloadedBytes: 400,
      })
      rpc.tellWaiting = vi.fn(async () => [
        makeRawStatus({
          gid,
          status: 'paused',
          totalLength: '0',
          completedLength: '0',
        }),
      ])
      rpc.tellStopped = vi.fn(async () => [
        makeRawStatus({
          gid,
          status: 'error',
          errorCode: '7',
          totalLength: '1000',
          completedLength: '100',
        }),
      ])
      rpc.tellStatus = vi.fn().mockRejectedValue(new Error('rpc unavailable'))

      await sessionManager.restore()

      expect(
        taskManager.getById('m-duplicate-arbitration-failed')
      ).toMatchObject({
        status: TaskStatus.Paused,
        totalBytes: 1000,
        downloadedBytes: 400,
        progress: 0.4,
      })
      expect(db.persistTaskWithOccurrence).not.toHaveBeenCalled()
    })

    it('does not hide a terminal transition that occurs during the list snapshot race', async () => {
      const gid = 'gid-completed-during-restore-scan'
      seedAsPair(db, {
        motrixId: 'm-completed-during-restore-scan',
        gid,
        status: TaskStatus.Downloading,
        totalBytes: 1000,
        downloadedBytes: 500,
      })
      // tellActive captured the task immediately before it completed.
      rpc.tellActive = vi.fn(async () => [
        makeRawStatus({
          gid,
          status: 'active',
          totalLength: '1000',
          completedLength: '700',
        }),
      ])
      // tellStopped captured the terminal row from the other side of the
      // transition. Fixed active-first precedence would incorrectly hide it.
      rpc.tellStopped = vi.fn(async () => [
        makeRawStatus({
          gid,
          status: 'complete',
          totalLength: '1000',
          completedLength: '1000',
        }),
      ])
      rpc.tellStatus = vi.fn(async () =>
        makeRawStatus({
          gid,
          status: 'complete',
          totalLength: '1000',
          completedLength: '1000',
        })
      )

      await sessionManager.restore()

      expect(
        taskManager.getById('m-completed-during-restore-scan')
      ).toMatchObject({
        status: TaskStatus.Completed,
        downloadedBytes: 1000,
        progress: 1,
      })
      expect(db.persistTaskWithOccurrence).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          task: expect.objectContaining({
            motrixId: 'm-completed-during-restore-scan',
            aggStatus: TaskStatus.Completed,
          }),
        }),
        expect.objectContaining({
          taskId: 'm-completed-during-restore-scan',
          fromStatus: TaskStatus.Downloading,
          toStatus: TaskStatus.Completed,
        })
      )
    })

    describe('persisted Error task with a resurrected engine row (shield)', () => {
      function seedErroredHttpTask(gid: string): void {
        seedAsPair(db, {
          motrixId: 'm-http-err',
          gid,
          name: 'missing.dmg',
          type: TaskType.Http,
          kind: TaskKind.Direct,
          uris: ['https://dl.example.com/missing.dmg'],
          uriHash: 'uri-hash-err',
          diskPath: '/tmp/missing.dmg.motrix',
          finalPath: '/tmp/missing.dmg',
          finalName: 'missing.dmg',
          status: TaskStatus.Error,
          finishedAt: 1700000005000,
          errorCode: DownloadErrorCode.NotFound,
          errorMessage: 'Resource not found',
        })
      }

      it('keeps Error history and evicts a LIVE resurrected row instead of merging it back to an active status', async () => {
        const gid = 'gid-resurrected'
        seedErroredHttpTask(gid)
        // The fork's session store reloaded the errored download at boot
        // and re-queued it — aria2 now reports the same gid as waiting.
        rpc.tellWaiting = vi.fn(async () => [
          makeRawStatus({ gid, status: 'waiting' }),
        ])
        rpc.tellStopped = vi.fn(async () => [
          makeRawStatus({ gid, status: 'error', errorCode: '3' }),
        ])
        rpc.tellStatus = vi.fn(async () =>
          makeRawStatus({ gid, status: 'waiting' })
        )

        await sessionManager.restore()

        const restored = taskManager.getAll().find((t) => t.id === 'm-http-err')
        expect(restored?.status).toBe(TaskStatus.Error)
        expect(restored?.errorCode).toBe(DownloadErrorCode.NotFound)
        expect(restored?.errorMessage).toBe('Resource not found')
        expect(adapter.forceRemoveTask).toHaveBeenCalledWith(gid)
        expect(adapter.removeDownloadResult).toHaveBeenCalledWith(gid)
        expect(adapter.forceRemoveTask).toHaveBeenCalledTimes(1)
        expect(adapter.removeDownloadResult).toHaveBeenCalledTimes(1)
        expect(adapter.createDownload).not.toHaveBeenCalled()
        expect(db.persistTaskWithOccurrence).not.toHaveBeenCalled()
      })

      it('purges a STOPPED errored engine row without force-removing it', async () => {
        const gid = 'gid-refailed'
        seedErroredHttpTask(gid)
        // The resurrected retry already re-failed before restore ran.
        rpc.tellStopped = vi.fn(async () => [
          makeRawStatus({ gid, status: 'error', errorCode: '3' }),
        ])

        await sessionManager.restore()

        const restored = taskManager.getAll().find((t) => t.id === 'm-http-err')
        expect(restored?.status).toBe(TaskStatus.Error)
        expect(adapter.forceRemoveTask).not.toHaveBeenCalled()
        expect(adapter.removeDownloadResult).toHaveBeenCalledWith(gid)
        expect(db.persistTaskWithOccurrence).not.toHaveBeenCalled()
      })

      it('still lands the task in Error when engine eviction fails', async () => {
        const gid = 'gid-evict-fail'
        seedErroredHttpTask(gid)
        rpc.tellWaiting = vi.fn(async () => [
          makeRawStatus({ gid, status: 'waiting' }),
        ])
        // forceRemoveTask succeeds so the failure exercises the second call
        // of the helper (a rejecting first call would short-circuit past it).
        adapter.removeDownloadResult = vi
          .fn()
          .mockRejectedValue(new Error('rpc down'))

        await sessionManager.restore()

        const restored = taskManager.getAll().find((t) => t.id === 'm-http-err')
        expect(restored?.status).toBe(TaskStatus.Error)
      })
    })

    it('marks BT task as recovery error when torrentMetaPath is missing', async () => {
      seedAsPair(db, {
        motrixId: 'm-bt-003',
        gid: 'lost-gid',
        name: 'gone.torrent',
        category: null,
        priority: 0,
        createdAt: 0,
        updatedAt: 0,
        diskPath: '',
        finalPath: '',
        finalName: '',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: '/nonexistent/path.torrent',
        infoHash: 'a'.repeat(40),
        uriHash: null,
        uris: [],
        status: TaskStatus.Downloading,
      })
      rpc.tellActive = vi.fn(async () => [])
      rpc.tellWaiting = vi.fn(async () => [])
      rpc.tellStopped = vi.fn(async () => [])

      await sessionManager.restore()

      const restored = taskManager.getAll().find((t) => t.id === 'm-bt-003')
      expect(restored?.status).toBe(TaskStatus.Error)
      expect(restored?.errorDetailKey).toBe(
        'task.recovery.startup.torrentMetaMissing'
      )
      expect(restored?.errorMessage).toBeNull()
      const persisted = db.getTask('m-bt-003')
      expect(persisted?.task).toMatchObject({
        aggStatus: TaskStatus.Error,
        finishedAt: restored?.finishedAt,
        errorDetailKey: 'task.recovery.startup.torrentMetaMissing',
        errorMessage: null,
      })

      const finishedAt = persisted?.task.finishedAt
      const restartedTasks = new TaskManager()
      await new SessionManager(restartedTasks, rpc, db, adapter).restore()
      expect(restartedTasks.getById('m-bt-003')?.finishedAt).toBe(finishedAt)
    })

    it('persists a failed BT re-add and does not retry it on the next restart', async () => {
      const torrentDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'motrix-restore-bt-fail-')
      )
      const torrentPath = path.join(torrentDir, 'failed.torrent')
      fs.writeFileSync(torrentPath, Buffer.from('torrent'))
      try {
        seedAsPair(db, {
          motrixId: 'm-bt-readd-failed',
          gid: 'lost-bt',
          name: 'failed.torrent',
          kind: TaskKind.Bt,
          type: TaskType.Bt,
          diskPath: '/tmp/failed.motrix',
          finalPath: '/tmp/failed',
          finalName: 'failed',
          torrentMetaPath: torrentPath,
          infoHash: 'b'.repeat(40),
          uris: [],
          status: TaskStatus.Downloading,
        })
        rpc.tellActive = vi.fn(async () => [])
        rpc.tellWaiting = vi.fn(async () => [])
        rpc.tellStopped = vi.fn(async () => [])
        ;(adapter.addTorrent as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error('re-add refused')
        )

        await sessionManager.restore()

        const persisted = db.getTask('m-bt-readd-failed')
        expect(persisted?.task).toMatchObject({
          aggStatus: TaskStatus.Error,
          finishedAt: expect.any(Number),
          errorDetailKey: 'task.recovery.startup.reAddFailed',
          errorMessage: null,
        })

        const finishedAt = persisted?.task.finishedAt
        vi.mocked(adapter.addTorrent).mockClear()
        const restartedTasks = new TaskManager()
        await new SessionManager(restartedTasks, rpc, db, adapter).restore()
        expect(adapter.addTorrent).not.toHaveBeenCalled()
        expect(restartedTasks.getById('m-bt-readd-failed')?.finishedAt).toBe(
          finishedAt
        )
      } finally {
        fs.rmSync(torrentDir, { recursive: true, force: true })
      }
    })

    it('re-adds HTTP task via adapter.createDownload when aria2 has lost it', async () => {
      seedAsPair(db, {
        motrixId: 'm-http-004',
        gid: 'lost-http',
        name: 'file.zip',
        category: null,
        priority: 0,
        createdAt: 0,
        updatedAt: 0,
        diskPath: '/tmp/file.zip.motrix',
        finalPath: '/tmp/file.zip',
        finalName: 'file.zip',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: null,
        infoHash: null,
        uriHash: 'aabbccddeeff0011',
        uris: ['http://example.com/file.zip'],
        status: TaskStatus.Downloading,
      })
      rpc.tellActive = vi.fn(async () => [])
      rpc.tellWaiting = vi.fn(async () => [])
      rpc.tellStopped = vi.fn(async () => [])
      ;(adapter.createDownload as ReturnType<typeof vi.fn>).mockImplementation(
        async ({ gid }: { gid?: string }) => gid ?? ''
      )

      await sessionManager.restore()

      expect(adapter.createDownload).toHaveBeenCalledTimes(1)
      expect(adapter.createDownload).toHaveBeenCalledWith({
        uris: ['http://example.com/file.zip'],
        gid: expect.stringMatching(/^[0-9a-f]{16}$/),
        saveDir: '/tmp',
        filename: 'file.zip.motrix',
        connections: undefined,
        pause: false,
        resumePolicy: 'none',
      })
      const restored = taskManager.getAll().find((t) => t.id === 'm-http-004')
      expect(restored?.engineTaskId).toMatch(/^[0-9a-f]{16}$/)
      expect(restored?.engineTaskId).not.toBe('lost-http')
    })

    it('blocks an HTTP checkpoint that has no captured resource validator', async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'motrix-http-checkpoint-')
      )
      const diskPath = path.join(tempDir, 'archive.zip.motrix')
      try {
        fs.writeFileSync(diskPath, Buffer.alloc(32, 0x61))
        fs.writeFileSync(`${diskPath}.aria2`, Buffer.alloc(16, 0x62))
        seedAsPair(db, {
          motrixId: 'm-http-checkpoint',
          gid: 'lost-http-checkpoint',
          name: 'archive.zip',
          diskPath,
          finalPath: path.join(tempDir, 'archive.zip'),
          finalName: 'archive.zip',
          uris: ['https://example.com/archive.zip'],
          status: TaskStatus.Downloading,
          payload: {
            directReplay: {
              version: 1,
              connections: 4,
              requestModifiers: [],
              replayability: 'uri-only',
            },
          },
        })
        ;(
          adapter.createDownload as ReturnType<typeof vi.fn>
        ).mockImplementation(async ({ gid }: { gid?: string }) => gid ?? '')

        await sessionManager.restore()

        expect(adapter.createDownload).not.toHaveBeenCalled()
        expect(taskManager.getById('m-http-checkpoint')).toMatchObject({
          status: TaskStatus.Error,
          errorDetailKey: 'task.recovery.startup.resumeValidationFailed',
        })
        expect(fs.existsSync(diskPath)).toBe(true)
        expect(fs.existsSync(`${diskPath}.aria2`)).toBe(true)
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it('validates a checkpoint source and dispatches it with If-Range', async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'motrix-http-validator-')
      )
      const diskPath = path.join(tempDir, 'archive.zip.motrix')
      const resourceValidator = {
        kind: 'strong-etag' as const,
        value: '"release-v1"',
        contentLength: 4096,
        capturedAt: 7,
      }
      let currentUserAgent = 'Motrix/Verified'
      const verify = vi.fn(async () => {
        currentUserAgent = 'Motrix/Newer'
        return {
          outcome: 'unchanged' as const,
          ifRange: resourceValidator.value,
        }
      })
      try {
        fs.writeFileSync(diskPath, Buffer.alloc(32, 0x61))
        fs.writeFileSync(`${diskPath}.aria2`, Buffer.alloc(16, 0x62))
        seedAsPair(db, {
          motrixId: 'm-http-validator',
          gid: 'lost-http-validator',
          name: 'archive.zip',
          diskPath,
          finalPath: path.join(tempDir, 'archive.zip'),
          finalName: 'archive.zip',
          uris: ['https://example.com/archive.zip'],
          status: TaskStatus.Downloading,
          payload: {
            directReplay: {
              version: 1,
              requestModifiers: [],
              replayability: 'uri-only',
              resourceValidator,
            },
          },
        })
        sessionManager = new SessionManager(
          taskManager,
          rpc,
          db,
          adapter,
          undefined,
          undefined,
          { verify },
          () => ({
            proxy: 'http://proxy.example:8080',
            noProxy: '.internal',
            userAgent: currentUserAgent,
          })
        )

        await sessionManager.restore()

        expect(verify).toHaveBeenCalledWith(
          'https://example.com/archive.zip',
          resourceValidator,
          {
            proxy: 'http://proxy.example:8080',
            noProxy: '.internal',
            userAgent: 'Motrix/Verified',
          }
        )
        expect(adapter.createDownload).toHaveBeenCalledWith(
          expect.objectContaining({
            headers: { 'If-Range': '"release-v1"' },
            userAgent: 'Motrix/Verified',
            resumePolicy: 'checkpoint',
          })
        )
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it.each(['unchanged', 'source-changed', 'unverifiable'] as const)(
      'does not persist a stale %s validation after proxy restart',
      async (outcome) => {
        const tempDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'motrix-http-validator-proxy-lease-')
        )
        const diskPath = path.join(tempDir, 'archive.zip.motrix')
        const resourceValidator = {
          kind: 'strong-etag' as const,
          value: '"release-v1"',
          capturedAt: 7,
        }
        const policy = new AppliedDownloadProxyPolicy({
          proxy: 'http://proxy.example:8080',
          noProxy: '.internal',
        })
        const verify = vi.fn(async () => {
          policy.markUnavailable()
          return {
            outcome,
            ifRange: outcome === 'unchanged' ? resourceValidator.value : null,
          }
        })
        try {
          fs.writeFileSync(diskPath, Buffer.alloc(32, 0x61))
          fs.writeFileSync(`${diskPath}.aria2`, Buffer.alloc(16, 0x62))
          seedAsPair(db, {
            motrixId: 'm-http-validator-proxy-lease',
            gid: 'lost-http-validator-proxy-lease',
            name: 'archive.zip',
            diskPath,
            finalPath: path.join(tempDir, 'archive.zip'),
            finalName: 'archive.zip',
            uris: ['https://example.com/archive.zip'],
            status: TaskStatus.Downloading,
            payload: {
              directReplay: {
                version: 1,
                requestModifiers: [],
                replayability: 'uri-only',
                resourceValidator,
              },
            },
          })
          sessionManager = new SessionManager(
            taskManager,
            rpc,
            db,
            adapter,
            undefined,
            undefined,
            { verify },
            () => policy.snapshot()
          )

          await expect(
            policy.runWithSnapshot((_snapshot, lease) =>
              sessionManager.restore(lease.assertCurrent)
            )
          ).rejects.toThrow('applied download proxy policy changed')

          expect(verify).toHaveBeenCalledOnce()
          expect(adapter.createDownload).not.toHaveBeenCalled()
          expect(
            taskManager.getById('m-http-validator-proxy-lease')
          ).toBeUndefined()
          expect(
            db.getTask('m-http-validator-proxy-lease')?.task.aggStatus
          ).toBe(TaskStatus.Downloading)
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true })
        }
      }
    )

    it.each([
      ['source-changed', 'task.recovery.startup.resumeSourceChanged'] as const,
      [
        'range-unsupported',
        'task.recovery.startup.resumeRangeUnsupported',
      ] as const,
      ['unverifiable', 'task.recovery.startup.resumeValidationFailed'] as const,
    ])(
      'blocks checkpoint recovery when source validation is %s',
      async (outcome, errorDetailKey) => {
        const tempDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'motrix-http-validator-blocked-')
        )
        const diskPath = path.join(tempDir, 'archive.zip.motrix')
        const partial = Buffer.from('preserve-partial')
        const checkpoint = Buffer.from('preserve-checkpoint')
        const resourceValidator = {
          kind: 'strong-etag' as const,
          value: '"release-v1"',
          contentLength: 4096,
          capturedAt: 7,
        }
        const verify = vi.fn().mockResolvedValue({ outcome, ifRange: null })
        try {
          fs.writeFileSync(diskPath, partial)
          fs.writeFileSync(`${diskPath}.aria2`, checkpoint)
          seedAsPair(db, {
            motrixId: `m-http-validator-${outcome}`,
            gid: `lost-http-validator-${outcome}`,
            name: 'archive.zip',
            diskPath,
            finalPath: path.join(tempDir, 'archive.zip'),
            finalName: 'archive.zip',
            uris: ['https://example.com/archive.zip'],
            status: TaskStatus.Downloading,
            payload: {
              directReplay: {
                version: 1,
                requestModifiers: [],
                replayability: 'uri-only',
                resourceValidator,
              },
            },
          })
          sessionManager = new SessionManager(
            taskManager,
            rpc,
            db,
            adapter,
            undefined,
            undefined,
            { verify },
            () => ({})
          )

          await sessionManager.restore()

          expect(adapter.createDownload).not.toHaveBeenCalled()
          expect(
            taskManager.getById(`m-http-validator-${outcome}`)
          ).toMatchObject({ status: TaskStatus.Error, errorDetailKey })
          expect(fs.readFileSync(diskPath)).toEqual(partial)
          expect(fs.readFileSync(`${diskPath}.aria2`)).toEqual(checkpoint)
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true })
        }
      }
    )

    it('does not verify a checkpoint when aria2 lacks mirrored header features', async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'motrix-http-validator-feature-profile-')
      )
      const diskPath = path.join(tempDir, 'archive.zip.motrix')
      const resourceValidator = {
        kind: 'strong-etag' as const,
        value: '"release-v1"',
        capturedAt: 7,
      }
      const verify = vi.fn()
      try {
        fs.writeFileSync(diskPath, Buffer.from('partial'))
        fs.writeFileSync(`${diskPath}.aria2`, Buffer.from('checkpoint'))
        seedAsPair(db, {
          motrixId: 'm-http-validator-feature-profile',
          gid: 'lost-http-validator-feature-profile',
          name: 'archive.zip',
          diskPath,
          finalPath: path.join(tempDir, 'archive.zip'),
          finalName: 'archive.zip',
          uris: ['https://example.com/archive.zip'],
          status: TaskStatus.Downloading,
          payload: {
            directReplay: {
              version: 1,
              requestModifiers: [],
              replayability: 'uri-only',
              resourceValidator,
            },
          },
        })
        vi.mocked(adapter.getFeatureReport).mockReturnValue({
          version: '1.37.0',
          features: ['GZip'],
          hasSqlitePersistence: false,
          hasBtSeedUnverified: false,
          hasBtSaveMetadata: false,
          hasMoveStorage: false,
        })
        sessionManager = new SessionManager(
          taskManager,
          rpc,
          db,
          adapter,
          undefined,
          undefined,
          { verify },
          () => ({})
        )

        await sessionManager.restore()

        expect(verify).not.toHaveBeenCalled()
        expect(adapter.createDownload).not.toHaveBeenCalled()
        expect(
          taskManager.getById('m-http-validator-feature-profile')
        ).toMatchObject({
          status: TaskStatus.Error,
          errorDetailKey: 'task.recovery.startup.resumeValidationFailed',
        })
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it('preserves a non-empty HTTP partial when its checkpoint is missing', async () => {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'motrix-http-no-checkpoint-')
      )
      const diskPath = path.join(tempDir, 'partial.bin.motrix')
      const bytes = Buffer.from('do-not-overwrite')
      try {
        fs.writeFileSync(diskPath, bytes)
        seedAsPair(db, {
          motrixId: 'm-http-no-checkpoint',
          gid: 'lost-http-no-checkpoint',
          name: 'partial.bin',
          diskPath,
          finalPath: path.join(tempDir, 'partial.bin'),
          finalName: 'partial.bin',
          uris: ['https://example.com/partial.bin'],
          status: TaskStatus.Downloading,
        })

        await sessionManager.restore()

        expect(adapter.createDownload).not.toHaveBeenCalled()
        expect(taskManager.getById('m-http-no-checkpoint')).toMatchObject({
          status: TaskStatus.Error,
          errorDetailKey: 'task.recovery.startup.resumeCheckpointMissing',
        })
        expect(fs.readFileSync(diskPath)).toEqual(bytes)
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it('does not replay a direct task whose request credentials were not persisted', async () => {
      seedAsPair(db, {
        motrixId: 'm-http-credentials',
        gid: 'lost-http-credentials',
        name: 'private.zip',
        diskPath: '/tmp/private.zip.motrix',
        finalPath: '/tmp/private.zip',
        finalName: 'private.zip',
        uris: ['https://example.com/private.zip'],
        status: TaskStatus.Downloading,
        payload: {
          directReplay: {
            version: 1,
            requestModifiers: ['headers'],
            replayability: 'requires-credentials',
          },
        },
      })

      await sessionManager.restore()

      expect(adapter.createDownload).not.toHaveBeenCalled()
      expect(taskManager.getById('m-http-credentials')).toMatchObject({
        status: TaskStatus.Error,
        errorDetailKey: 'task.recovery.startup.resumeCredentialsRequired',
      })
    })

    it('persists the reserved recovery gid before dispatching HTTP', async () => {
      seedAsPair(db, {
        motrixId: 'm-http-durable-gid',
        gid: 'lost-http-durable-gid',
        name: 'durable.bin',
        diskPath: '/tmp/durable.bin.motrix',
        finalPath: '/tmp/durable.bin',
        finalName: 'durable.bin',
        uris: ['https://example.com/durable.bin'],
        status: TaskStatus.Downloading,
      })
      ;(adapter.createDownload as ReturnType<typeof vi.fn>).mockImplementation(
        async ({ gid }: { gid?: string }) => {
          expect(db.getTask('m-http-durable-gid')?.instances[0]?.gid).toBe(gid)
          return gid ?? ''
        }
      )

      await sessionManager.restore()

      expect(taskManager.getById('m-http-durable-gid')?.engineTaskId).toMatch(
        /^[0-9a-f]{16}$/
      )
    })

    it('preserves a no-live-gid HTTP rename intent for startup recovery instead of re-adding', async () => {
      seedAsPair(db, {
        motrixId: 'm-http-renaming',
        gid: 'retired-http-gid',
        name: 'file.zip',
        diskPath: '/tmp/file.zip.motrix',
        finalPath: '/tmp/file.zip',
        finalName: 'file.zip',
        transitionPhase: TransitionPhase.Renaming,
        torrentMetaPath: null,
        infoHash: null,
        uriHash: 'http-renaming-hash',
        uris: ['https://example.com/file.zip'],
        status: TaskStatus.Finalizing,
      })
      rpc.tellActive = vi.fn(async () => [])
      rpc.tellWaiting = vi.fn(async () => [])
      rpc.tellStopped = vi.fn(async () => [])

      await sessionManager.restore()

      expect(adapter.createDownload).not.toHaveBeenCalled()
      expect(taskManager.getById('m-http-renaming')).toMatchObject({
        engineTaskId: 'retired-http-gid',
        status: TaskStatus.Finalizing,
        transitionPhase: TransitionPhase.Renaming,
      })
    })

    it('repairs Finalizing + Idle to Renaming so startup recovery cannot no-op forever', async () => {
      seedAsPair(db, {
        motrixId: 'm-http-finalizing-idle',
        gid: 'retired-http-idle-gid',
        name: 'file.zip',
        diskPath: '/tmp/file.zip.motrix',
        finalPath: '/tmp/file.zip',
        finalName: 'file.zip',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: null,
        infoHash: null,
        uriHash: 'http-finalizing-idle-hash',
        uris: ['https://example.com/file.zip'],
        status: TaskStatus.Finalizing,
      })
      rpc.tellActive = vi.fn(async () => [])
      rpc.tellWaiting = vi.fn(async () => [])
      rpc.tellStopped = vi.fn(async () => [])

      await sessionManager.restore()

      expect(adapter.createDownload).not.toHaveBeenCalled()
      const restored = taskManager.getById('m-http-finalizing-idle')
      expect(restored).toMatchObject({
        status: TaskStatus.Finalizing,
        transitionPhase: TransitionPhase.Renaming,
      })
      expect(
        restored?.instances.every(
          (instance) => instance.transitionPhase === TransitionPhase.Renaming
        )
      ).toBe(true)
    })

    it('preserves a no-live-gid media rename intent instead of converting it to startup Error', async () => {
      seedAsPair(db, {
        motrixId: 'm-media-renaming',
        gid: null,
        name: 'movie.mp4',
        kind: TaskKind.Mux,
        type: TaskType.Http,
        diskPath: '/tmp/movie.mp4.motrix',
        finalPath: '/tmp/movie.mp4',
        finalName: 'movie.mp4',
        transitionPhase: TransitionPhase.Renaming,
        torrentMetaPath: null,
        infoHash: null,
        uriHash: null,
        uris: [],
        status: TaskStatus.Finalizing,
      })
      rpc.tellActive = vi.fn(async () => [])
      rpc.tellWaiting = vi.fn(async () => [])
      rpc.tellStopped = vi.fn(async () => [])

      await sessionManager.restore()

      expect(taskManager.getById('m-media-renaming')).toMatchObject({
        status: TaskStatus.Finalizing,
        transitionPhase: TransitionPhase.Renaming,
      })
    })

    it('does not assign an unknown BT gid by infoHash when two tasks share that torrent', async () => {
      const infoHash = 'd'.repeat(40)
      seedAsPair(db, {
        motrixId: 'same-hash-a',
        gid: 'old-gid-a',
        name: 'copy-a',
        kind: TaskKind.Bt,
        type: TaskType.Bt,
        diskPath: '/downloads/a.motrix',
        finalPath: '/downloads/a',
        finalName: 'a',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: '/missing/a.torrent',
        infoHash,
        uriHash: null,
        uris: [],
        status: TaskStatus.Downloading,
      })
      seedAsPair(db, {
        motrixId: 'same-hash-b',
        gid: 'old-gid-b',
        name: 'copy-b',
        kind: TaskKind.Bt,
        type: TaskType.Bt,
        diskPath: '/downloads/b.motrix',
        finalPath: '/downloads/b',
        finalName: 'b',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: '/missing/b.torrent',
        infoHash,
        uriHash: null,
        uris: [],
        status: TaskStatus.Downloading,
      })
      rpc.tellActive = vi.fn(async () => [
        makeRawStatus({
          gid: 'unknown-live-gid',
          infoHash,
          dir: '/downloads/b',
          bittorrent: {
            announceList: [],
            mode: 'single',
            info: { name: 'copy-b' },
          },
        }),
      ])
      rpc.tellWaiting = vi.fn(async () => [])
      rpc.tellStopped = vi.fn(async () => [])

      await sessionManager.restore()

      expect(taskManager.getById('same-hash-a')?.engineTaskId).not.toBe(
        'unknown-live-gid'
      )
      expect(taskManager.getById('same-hash-b')?.engineTaskId).not.toBe(
        'unknown-live-gid'
      )
      expect(taskManager.getByEngineTaskId('unknown-live-gid')?.id).not.toBe(
        'same-hash-a'
      )
      expect(taskManager.getByEngineTaskId('unknown-live-gid')?.id).not.toBe(
        'same-hash-b'
      )
    })

    it('marks task as dirtyMetadata error when no content key and no uris', async () => {
      seedAsPair(db, {
        motrixId: 'm-005',
        gid: 'orphan',
        name: 'orphan',
        category: null,
        priority: 0,
        createdAt: 0,
        updatedAt: 0,
        diskPath: '',
        finalPath: '',
        finalName: '',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: null,
        infoHash: null,
        uriHash: null,
        uris: [],
        status: TaskStatus.Queued,
      })
      rpc.tellActive = vi.fn(async () => [])
      rpc.tellWaiting = vi.fn(async () => [])
      rpc.tellStopped = vi.fn(async () => [])

      await sessionManager.restore()

      const restored = taskManager.getAll().find((t) => t.id === 'm-005')
      expect(restored?.status).toBe(TaskStatus.Error)
      expect(restored?.errorDetailKey).toBe(
        'task.recovery.startup.dirtyMetadata'
      )
      expect(restored?.errorMessage).toBeNull()
    })

    it('skips re-adding Completed tasks (just registers metadata)', async () => {
      const oldGid = 'completed-gid'
      seedAsPair(db, {
        motrixId: 'm-completed',
        gid: oldGid,
        name: 'done.iso',
        category: null,
        priority: 0,
        createdAt: 0,
        updatedAt: 0,
        diskPath: '/tmp/done.iso',
        finalPath: '/tmp/done.iso',
        finalName: 'done.iso',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: null,
        infoHash: 'b'.repeat(40),
        uriHash: null,
        uris: [],
        status: TaskStatus.Completed,
      })
      rpc.tellActive = vi.fn(async () => [])
      rpc.tellWaiting = vi.fn(async () => [])
      rpc.tellStopped = vi.fn(async () => [])

      await sessionManager.restore()

      expect(adapter.addTorrent).not.toHaveBeenCalled()
      expect(adapter.createDownload).not.toHaveBeenCalled()
      const restored = taskManager.getAll().find((t) => t.id === 'm-completed')
      expect(restored?.status).toBe(TaskStatus.Completed)
    })

    it('heals a Completed task whose legacy instance row still holds the .motrix path', async () => {
      // Rows persisted before finalizeTask synced instance diskPath keep
      // the in-flight `.motrix` placeholder in task_instances while the
      // tasks row carries the correct finalPath. Restoring such a row
      // verbatim resurrects a path that no longer exists on disk,
      // breaking reveal-in-folder and delete-with-files. finalPath is
      // authoritative for a Completed task (finalize's rename target,
      // including plugin-overridden renames) — heal from it.
      seedAsPair(db, {
        motrixId: 'm-legacy-completed',
        gid: 'legacy-gid',
        name: 'movie.mkv',
        category: null,
        priority: 0,
        createdAt: 0,
        updatedAt: 0,
        diskPath: '/dl/movie.mkv.motrix',
        finalPath: '/dl/movie-final.mkv',
        finalName: 'movie-final.mkv',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: null,
        infoHash: null,
        uriHash: 'feedbead12345678',
        uris: ['https://example.com/movie.mkv'],
        status: TaskStatus.Completed,
      })
      rpc.tellActive = vi.fn(async () => [])
      rpc.tellWaiting = vi.fn(async () => [])
      rpc.tellStopped = vi.fn(async () => [])

      await sessionManager.restore()

      const restored = taskManager
        .getAll()
        .find((t) => t.id === 'm-legacy-completed')
      expect(restored?.diskPath).toBe('/dl/movie-final.mkv')
      expect(restored?.saveDir).toBe('/dl/movie-final.mkv')
      // Instances heal too, so the next save() rewrites the DB row and
      // the stale placeholder is gone for good.
      expect(restored?.instances[0]?.diskPath).toBe('/dl/movie-final.mkv')
    })

    it('preserves Paused state when re-adding HTTP task', async () => {
      seedAsPair(db, {
        motrixId: 'm-http-paused',
        gid: 'http-paused-gid',
        name: 'ubuntu-25.10-desktop-amd64.iso',
        category: null,
        priority: 0,
        createdAt: 0,
        updatedAt: 0,
        diskPath: '/tmp/ubuntu.iso.motrix',
        finalPath: '/tmp/ubuntu.iso',
        finalName: 'ubuntu-25.10-desktop-amd64.iso',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: null,
        infoHash: null,
        uriHash: 'abcdef0123456789',
        uris: ['https://releases.ubuntu.com/25.10/ubuntu-25.10.iso'],
        status: TaskStatus.Paused,
      })

      rpc.tellActive = vi.fn(async () => [])
      rpc.tellWaiting = vi.fn(async () => [])
      rpc.tellStopped = vi.fn(async () => [])
      ;(adapter.createDownload as ReturnType<typeof vi.fn>).mockImplementation(
        async ({ gid }: { gid?: string }) => gid ?? ''
      )

      await sessionManager.restore()

      expect(adapter.createDownload).toHaveBeenCalledWith(
        expect.objectContaining({ pause: true })
      )
      const restored = taskManager
        .getAll()
        .find((t) => t.id === 'm-http-paused')
      expect(restored?.status).toBe(TaskStatus.Paused)
      expect(restored?.engineTaskId).toMatch(/^[0-9a-f]{16}$/)
    })

    it('does not pause Downloading HTTP task on re-add', async () => {
      seedAsPair(db, {
        motrixId: 'm-http-dl',
        gid: 'http-dl-gid',
        name: 'file.zip',
        category: null,
        priority: 0,
        createdAt: 0,
        updatedAt: 0,
        diskPath: '/tmp/file.motrix',
        finalPath: '/tmp/file.zip',
        finalName: 'file.zip',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: null,
        infoHash: null,
        uriHash: 'fedcba9876543210',
        uris: ['https://example.com/file.zip'],
        status: TaskStatus.Downloading,
      })

      rpc.tellActive = vi.fn(async () => [])
      rpc.tellWaiting = vi.fn(async () => [])
      rpc.tellStopped = vi.fn(async () => [])
      ;(adapter.createDownload as ReturnType<typeof vi.fn>).mockImplementation(
        async ({ gid }: { gid?: string }) => gid ?? ''
      )

      await sessionManager.restore()

      expect(adapter.createDownload).toHaveBeenCalledWith(
        expect.objectContaining({ pause: false })
      )
    })

    it('preserves Paused state when re-adding BT task', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'motrix-paused-'))
      const torrentPath = path.join(tmpDir, 'p.torrent')
      fs.writeFileSync(
        torrentPath,
        Buffer.from('d4:infod4:name1:f12:piece lengthi1e6:pieces3:abcee')
      )

      seedAsPair(db, {
        motrixId: 'm-paused',
        gid: 'paused-gid',
        name: 'p.torrent',
        category: null,
        priority: 0,
        createdAt: 0,
        updatedAt: 0,
        diskPath: '/tmp/p.motrix',
        finalPath: '/tmp/p',
        finalName: 'p',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: torrentPath,
        infoHash: null,
        uriHash: null,
        uris: [],
        status: TaskStatus.Paused,
      })

      rpc.tellActive = vi.fn(async () => [])
      rpc.tellWaiting = vi.fn(async () => [])
      rpc.tellStopped = vi.fn(async () => [])
      ;(adapter.addTorrent as ReturnType<typeof vi.fn>).mockImplementation(
        async ({ gid }: { gid?: string }) => gid ?? ''
      )

      await sessionManager.restore()

      expect(adapter.addTorrent).toHaveBeenCalledWith(
        expect.objectContaining({ pause: true })
      )
      const restored = taskManager.getAll().find((t) => t.id === 'm-paused')
      expect(restored?.status).toBe(TaskStatus.Paused)

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('preserves Downloading state when re-adding BT task', async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'motrix-downloading-')
      )
      const torrentPath = path.join(tmpDir, 'd.torrent')
      fs.writeFileSync(
        torrentPath,
        Buffer.from('d4:infod4:name1:f12:piece lengthi1e6:pieces3:abcee')
      )

      seedAsPair(db, {
        motrixId: 'm-downloading',
        gid: 'downloading-gid',
        name: 'd.torrent',
        category: null,
        priority: 0,
        createdAt: 0,
        updatedAt: 0,
        diskPath: '/tmp/d.motrix',
        finalPath: '/tmp/d',
        finalName: 'd',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: torrentPath,
        infoHash: null,
        uriHash: null,
        uris: [],
        status: TaskStatus.Downloading,
      })

      rpc.tellActive = vi.fn(async () => [])
      rpc.tellWaiting = vi.fn(async () => [])
      rpc.tellStopped = vi.fn(async () => [])
      ;(adapter.addTorrent as ReturnType<typeof vi.fn>).mockImplementation(
        async ({ gid }: { gid?: string }) => gid ?? ''
      )

      await sessionManager.restore()

      expect(adapter.addTorrent).toHaveBeenCalledWith(
        expect.objectContaining({ pause: false })
      )
      const restored = taskManager
        .getAll()
        .find((t) => t.id === 'm-downloading')
      expect(restored?.status).toBe(TaskStatus.Downloading)

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('falls back to saved mirror when engine reports zero', async () => {
      // Paused tasks frequently surface as totalLength="0" / completedLength="0"
      // from aria2 immediately after restart. The persisted mirror columns
      // should win in that case so the UI keeps rendering the last-known
      // sizes/counts rather than zeroing out.
      const gid = 'paused-mirror-gid'
      seedAsPair(db, {
        motrixId: 'm-mirror-paused',
        gid,
        name: 'paused.iso',
        category: null,
        priority: 0,
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
        diskPath: '/tmp/paused.iso.motrix',
        finalPath: '/tmp/paused.iso',
        finalName: 'paused.iso',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: null,
        infoHash: null,
        uriHash: 'aabbccdd11223344',
        uris: ['http://example.com/paused.iso'],
        status: TaskStatus.Paused,
        totalBytes: 1024,
        downloadedBytes: 512,
        sizeWhenDone: 1024,
        uploadedBytes: 0,
        uploadedBytesBaseline: 0,
        fileCount: 2,
      })

      rpc.tellActive = vi.fn(async () => [])
      rpc.tellWaiting = vi.fn(async () => [])
      rpc.tellStopped = vi.fn(async () => [
        makeRawStatus({
          gid,
          status: 'paused',
          totalLength: '0',
          completedLength: '0',
          uploadLength: '0',
          downloadSpeed: '0',
          uploadSpeed: '0',
          connections: '0',
          files: [],
        }),
      ])

      await sessionManager.restore()

      const restored = taskManager
        .getAll()
        .find((t) => t.id === 'm-mirror-paused')
      expect(restored).toBeDefined()
      expect(restored?.totalBytes).toBe(1024)
      expect(restored?.downloadedBytes).toBe(512)
      expect(restored?.sizeWhenDone).toBe(1024)
      expect(restored?.fileCount).toBe(2)
    })

    it('reseeds bt.selectedFiles from task_files on restore (orphan path)', async () => {
      // The reseed loop runs at the end of restore() and only acts when
      // task.bt is populated. The orphan-adopt path goes through
      // translateRawToTask which populates bt whenever raw.bittorrent is
      // present. Adopt once to discover the generated motrixId, then
      // populate task_files keyed by that id and adopt again — the
      // reseed loop will overwrite the raw-derived selectedFiles with
      // the persisted user-edited subset.
      const gid = 'bt-orphan-files-gid'
      const rawBt = makeRawStatus({
        gid,
        status: 'paused',
        infoHash: 'c'.repeat(40),
        bittorrent: {
          announceList: [],
          mode: 'multi',
          info: { name: 'multi' },
        },
        // Three files all marked selected in raw — without the reseed
        // override the bt block would carry [0, 1, 2].
        files: [
          {
            index: '1',
            path: '/tmp/multi/a.bin',
            length: '100',
            completedLength: '0',
            selected: 'true',
            uris: [],
          },
          {
            index: '2',
            path: '/tmp/multi/b.bin',
            length: '200',
            completedLength: '0',
            selected: 'true',
            uris: [],
          },
          {
            index: '3',
            path: '/tmp/multi/c.bin',
            length: '300',
            completedLength: '0',
            selected: 'true',
            uris: [],
          },
        ],
      })

      rpc.tellActive = vi.fn(async () => [rawBt])
      rpc.tellWaiting = vi.fn(async () => [])
      rpc.tellStopped = vi.fn(async () => [])

      // Discovery pass: find the generated motrixId for this orphan.
      await sessionManager.restore()
      const adopted = taskManager.getAll().find((t) => t.engineTaskId === gid)
      if (!adopted) throw new Error('orphan adopt failed')
      const motrixId = adopted.id
      expect(adopted.bt?.selectedFiles).toEqual([0, 1, 2])

      // Persist user-edited selection (drop index 1) under the known id,
      // clear the in-memory state, and adopt again. The reseed loop must
      // override the raw-derived [0, 1, 2] with [0, 2].
      db.replaceTaskFiles(motrixId, [
        { fileIndex: 0, path: 'a.bin', size: 100, selected: true },
        { fileIndex: 1, path: 'b.bin', size: 200, selected: false },
        { fileIndex: 2, path: 'c.bin', size: 300, selected: true },
      ])
      // Use a fixed newTaskId by mocking — adoptTask calls newTaskId(), and
      // we need the second adopt to use the same motrixId so task_files
      // keyed by it are picked up.
      const idsModule = await import('@core/lib/ids')
      const idSpy = vi.spyOn(idsModule, 'newTaskId').mockReturnValue(motrixId)

      taskManager.clear()
      await sessionManager.restore()

      const reseeded = taskManager.getAll().find((t) => t.id === motrixId)
      expect(reseeded?.bt?.selectedFiles).toEqual([0, 2])
      idSpy.mockRestore()
    })

    it('reseeds bt.selectedFiles from task_files on restore (sidecar-merge path)', async () => {
      // Regression test for the d4acedd fix: mergeTask must populate `bt`
      // so the reseed loop can override selectedFiles with the persisted
      // user edit. Without that fix, sidecar-restored BT tasks lost the
      // user's selection on the very next poll. This is the most common
      // restart path (db has the metadata, aria2 still has the gid).
      const motrixId = 'm-sidecar-bt'
      const gid = 'bt-sidecar-files-gid'
      const infoHash = 'd'.repeat(40)

      seedAsPair(db, {
        motrixId,
        gid,
        name: 'multi.iso',
        category: null,
        priority: 0,
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
        diskPath: '/tmp/multi',
        finalPath: '/tmp/multi',
        finalName: 'multi',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: null,
        infoHash,
        uriHash: null,
        uris: [],
        status: TaskStatus.Paused,
      })

      // Persist the user-edited selection: drop index 1.
      db.replaceTaskFiles(motrixId, [
        { fileIndex: 0, path: 'a.bin', size: 100, selected: true },
        { fileIndex: 1, path: 'b.bin', size: 200, selected: false },
        { fileIndex: 2, path: 'c.bin', size: 300, selected: true },
      ])

      // aria2 reports the same gid with all three files marked selected.
      // mergeTask must produce bt.selectedFiles = [0, 1, 2] from raw, then
      // the reseed loop must override it with [0, 2] from task_files.
      rpc.tellActive = vi.fn(async () => [])
      rpc.tellWaiting = vi.fn(async () => [])
      rpc.tellStopped = vi.fn(async () => [
        makeRawStatus({
          gid,
          status: 'paused',
          infoHash,
          bittorrent: {
            announceList: [],
            mode: 'multi',
            info: { name: 'multi' },
          },
          files: [
            {
              index: '1',
              path: '/tmp/multi/a.bin',
              length: '100',
              completedLength: '0',
              selected: 'true',
              uris: [],
            },
            {
              index: '2',
              path: '/tmp/multi/b.bin',
              length: '200',
              completedLength: '0',
              selected: 'true',
              uris: [],
            },
            {
              index: '3',
              path: '/tmp/multi/c.bin',
              length: '300',
              completedLength: '0',
              selected: 'true',
              uris: [],
            },
          ],
        }),
      ])

      await sessionManager.restore()

      const restored = taskManager.getAll().find((t) => t.id === motrixId)
      expect(restored).toBeDefined()
      expect(restored?.engineTaskId).toBe(gid)
      expect(restored?.bt).toBeDefined()
      expect(restored?.bt?.selectedFiles).toEqual([0, 2])
    })

    describe('media (mux/hls) tasks', () => {
      it('restores a Completed mux task at progress 1, not 0 (totalBytes:0)', async () => {
        // The bilibili bug: MediaTaskCoordinator persists a mux task with
        // totalBytes:0/downloadedBytes:0. On restart it has no live aria2 gid
        // (segments are ephemeral under mediaTmpRoot), lands in Pass 2's
        // Completed branch → adoptByPair, whose byte-derived progress was 0.
        seedAsPair(db, {
          motrixId: 'm-mux-done',
          gid: '',
          name: 'bilibili-video.mp4',
          kind: TaskKind.Mux,
          source: 'bridge',
          finalPath: '/Downloads/bilibili-video.mp4',
          finalName: 'bilibili-video.mp4',
          torrentMetaPath: null,
          infoHash: null,
          uriHash: null,
          uris: [],
          status: TaskStatus.Completed,
          totalBytes: 0,
          downloadedBytes: 0,
        })
        rpc.tellActive = vi.fn(async () => [])
        rpc.tellStopped = vi.fn(async () => [])

        await sessionManager.restore()

        expect(adapter.createDownload).not.toHaveBeenCalled()
        expect(adapter.addTorrent).not.toHaveBeenCalled()
        const restored = taskManager.getAll().find((t) => t.id === 'm-mux-done')
        expect(restored?.status).toBe(TaskStatus.Completed)
        expect(restored?.progress).toBe(1)
      })

      it('restores a Completed hls task at progress 1 (dash/hls both persist Hls)', async () => {
        seedAsPair(db, {
          motrixId: 'm-hls-done',
          gid: '',
          name: 'stream.mp4',
          kind: TaskKind.Hls,
          source: 'bridge',
          finalPath: '/Downloads/stream.mp4',
          finalName: 'stream.mp4',
          torrentMetaPath: null,
          infoHash: null,
          uriHash: null,
          uris: [],
          status: TaskStatus.Completed,
          totalBytes: 0,
          downloadedBytes: 0,
        })
        rpc.tellActive = vi.fn(async () => [])
        rpc.tellStopped = vi.fn(async () => [])

        await sessionManager.restore()

        const restored = taskManager.getAll().find((t) => t.id === 'm-hls-done')
        expect(restored?.status).toBe(TaskStatus.Completed)
        expect(restored?.progress).toBe(1)
      })

      it('marks an in-progress media task Error on restart (cannot resume; not re-added)', async () => {
        seedAsPair(db, {
          motrixId: 'm-mux-live',
          gid: '',
          name: 'half-done.mp4',
          kind: TaskKind.Mux,
          source: 'bridge',
          finalPath: '/Downloads/half-done.mp4',
          finalName: 'half-done.mp4',
          torrentMetaPath: null,
          infoHash: null,
          uriHash: null,
          uris: [],
          status: TaskStatus.Downloading,
        })
        rpc.tellActive = vi.fn(async () => [])
        rpc.tellStopped = vi.fn(async () => [])

        await sessionManager.restore()

        expect(adapter.createDownload).not.toHaveBeenCalled()
        expect(adapter.addTorrent).not.toHaveBeenCalled()
        const restored = taskManager.getAll().find((t) => t.id === 'm-mux-live')
        expect(restored?.status).toBe(TaskStatus.Error)
        expect(restored?.finishedAt).not.toBeNull()
        const persisted = db.getTask('m-mux-live')
        expect(persisted?.task).toMatchObject({
          aggStatus: TaskStatus.Error,
          finishedAt: restored?.finishedAt,
          errorDetailKey: 'task.recovery.startup.mediaInterrupted',
          errorMessage: null,
        })
        expect(persisted?.instances[0].status).toBe(TaskStatus.Error)
        // Routed through the occurrence-aware persist path (cause
        // 'recovery') instead of only the end-of-restore batch saveNow().
        expect(db.persistTaskWithOccurrence).toHaveBeenCalledWith(
          expect.objectContaining({
            task: expect.objectContaining({
              motrixId: 'm-mux-live',
              aggStatus: TaskStatus.Error,
            }),
          }),
          expect.objectContaining({
            type: 'terminal',
            taskId: 'm-mux-live',
            fromStatus: TaskStatus.Downloading,
            toStatus: TaskStatus.Error,
            cause: 'recovery',
          })
        )

        const finishedAt = persisted?.task.finishedAt
        const restartedTasks = new TaskManager()
        await new SessionManager(restartedTasks, rpc, db, adapter).restore()
        expect(restartedTasks.getById('m-mux-live')?.finishedAt).toBe(
          finishedAt
        )
      })

      it('retains an existing media Error and its failure metadata', async () => {
        seedAsPair(db, {
          motrixId: 'm-mux-error',
          gid: '',
          name: 'failed.mp4',
          kind: TaskKind.Mux,
          type: TaskType.Http,
          source: 'bridge',
          finalPath: '/Downloads/failed.mp4',
          finalName: 'failed.mp4',
          uris: [],
          status: TaskStatus.Error,
          finishedAt: 5678,
          errorMessage: 'ffmpeg failed',
          errorCode: DownloadErrorCode.Unknown,
        })
        rpc.tellActive = vi.fn(async () => [])
        rpc.tellStopped = vi.fn(async () => [])

        await sessionManager.restore()

        const restored = taskManager
          .getAll()
          .find((t) => t.id === 'm-mux-error')
        expect(restored).toMatchObject({
          type: TaskType.Http,
          kind: TaskKind.Mux,
          status: TaskStatus.Error,
          finishedAt: 5678,
          errorMessage: 'ffmpeg failed',
          errorCode: DownloadErrorCode.Unknown,
        })
        expect(adapter.createDownload).not.toHaveBeenCalled()
      })

      it('does not regress a normal Completed http task (still 100%)', async () => {
        seedAsPair(db, {
          motrixId: 'm-http-done',
          gid: '',
          name: 'file.bin',
          kind: TaskKind.Direct,
          finalPath: '/Downloads/file.bin',
          finalName: 'file.bin',
          torrentMetaPath: null,
          infoHash: null,
          uriHash: null,
          uris: ['https://h/file.bin'],
          status: TaskStatus.Completed,
          totalBytes: 1000,
          downloadedBytes: 1000,
        })
        rpc.tellActive = vi.fn(async () => [])
        rpc.tellStopped = vi.fn(async () => [])

        await sessionManager.restore()

        const restored = taskManager
          .getAll()
          .find((t) => t.id === 'm-http-done')
        expect(restored?.status).toBe(TaskStatus.Completed)
        expect(restored?.progress).toBe(1)
      })
    })
  })

  describe('recoverLegacyTaskLost', () => {
    it('re-runs reconciliation for tasks marked with the legacy error message', async () => {
      const torrentDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'motrix-legacy-')
      )
      const torrentPath = path.join(torrentDir, 'legacy.torrent')
      fs.writeFileSync(
        torrentPath,
        Buffer.from('d4:infod4:name1:f12:piece lengthi1e6:pieces3:abcee')
      )

      seedAsPair(db, {
        motrixId: 'm-legacy',
        gid: 'legacy-gid',
        name: 'legacy.iso',
        category: null,
        priority: 0,
        createdAt: 0,
        updatedAt: 0,
        diskPath: '',
        finalPath: '',
        finalName: '',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: torrentPath,
        infoHash: null,
        uriHash: null,
        uris: [],
        status: TaskStatus.Downloading, // any non-error legacy state
      })

      const errored = createTask({
        id: 'm-legacy',
        engineTaskId: 'legacy-gid',
        status: TaskStatus.Error,
        errorMessage: 'Task lost: aria2 engine no longer has this download',
        torrentMetaPath: torrentPath,
      })
      taskManager.add(errored)

      ;(adapter.addTorrent as ReturnType<typeof vi.fn>).mockImplementation(
        async ({ gid }: { gid?: string }) => gid ?? ''
      )

      await session.recoverLegacyTaskLost()

      expect(adapter.addTorrent).toHaveBeenCalledTimes(1)
      const recovered = taskManager.getAll().find((t) => t.id === 'm-legacy')
      expect(recovered?.status).not.toBe(TaskStatus.Error)
      expect(recovered?.engineTaskId).toMatch(/^[0-9a-f]{16}$/)
      expect(recovered?.engineTaskId).not.toBe('legacy-gid')

      fs.rmSync(torrentDir, { recursive: true, force: true })
    })

    it('does nothing for tasks with non-legacy error messages', async () => {
      const errored = createTask({
        id: 'm-other',
        status: TaskStatus.Error,
        errorMessage: 'connection timeout',
      })
      taskManager.add(errored)

      await session.recoverLegacyTaskLost()

      expect(adapter.addTorrent).not.toHaveBeenCalled()
    })
  })

  describe('restore Pass 1 — terminal edge from a stopped aria2 row', () => {
    function seedMergePair(status: TaskStatus) {
      const tm = new TaskManager()
      const localDb = createMockDb()
      const localRpc = createMockRpc()
      const sm = new SessionManager(tm, localRpc, localDb, createMockAdapter())
      seedAsPair(localDb, {
        motrixId: 'm-merge-terminal',
        gid: 'gid-merge-terminal',
        name: 'merged.zip',
        status,
        diskPath: '/tmp/merged.zip.motrix',
        finalPath: '/tmp/merged.zip',
        finalName: 'merged.zip',
      })
      localRpc.tellActive = vi.fn(async () => [])
      localRpc.tellWaiting = vi.fn(async () => [])
      localRpc.tellStopped = vi.fn(async () => [
        makeRawStatus({
          gid: 'gid-merge-terminal',
          status: 'complete',
          totalLength: '100',
          completedLength: '100',
        }),
      ])
      return { tm, localDb, sm }
    }

    it('writes one Completed occurrence when the persisted task was still Downloading', async () => {
      const { tm, localDb, sm } = seedMergePair(TaskStatus.Downloading)

      await sm.restore()

      expect(tm.getById('m-merge-terminal')?.status).toBe(TaskStatus.Completed)
      expect(localDb.persistTaskWithOccurrence).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          task: expect.objectContaining({
            motrixId: 'm-merge-terminal',
            aggStatus: TaskStatus.Completed,
          }),
        }),
        expect.objectContaining({
          type: 'terminal',
          taskId: 'm-merge-terminal',
          fromStatus: TaskStatus.Downloading,
          toStatus: TaskStatus.Completed,
          cause: 'engine',
        })
      )
    })

    it('writes no occurrence when the persisted task was already Completed', async () => {
      const { tm, localDb, sm } = seedMergePair(TaskStatus.Completed)

      await sm.restore()

      expect(tm.getById('m-merge-terminal')?.status).toBe(TaskStatus.Completed)
      expect(localDb.persistTaskWithOccurrence).not.toHaveBeenCalled()
    })
  })

  describe('mergeTask — isPrivate injection', () => {
    // These tests previously poked at a private `mergeTask(saved, raw)`
    // method on SessionManager. Plan A renamed it to `mergeTaskFromPair`
    // and changed its signature (now `(pair, matchedInstance, aria2)`).
    // To stay grounded in observable behavior — and avoid private-member
    // access entirely — drive everything through the public `restore()`
    // pipeline. The mergeTask path is what restore() invokes when an
    // aria2 row matches a persisted pair by gid.
    it('mergeTask injects saved.isPrivate=true into bt.isPrivate', async () => {
      const tm = new TaskManager()
      const localDb = createMockDb()
      const localRpc = createMockRpc()
      const sm = new SessionManager(tm, localRpc, localDb, createMockAdapter())
      seedAsPair(localDb, {
        motrixId: 'm-private-true',
        gid: 'gid-private-true',
        name: 'private.torrent',
        category: null,
        priority: 0,
        createdAt: 0,
        updatedAt: 0,
        diskPath: '/tmp',
        finalPath: '/tmp',
        finalName: 'private',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: null,
        infoHash: 'a'.repeat(40),
        uriHash: null,
        uris: [],
        status: TaskStatus.Downloading,
        isPrivate: true,
      })
      localRpc.tellActive = vi.fn(async () => [
        makeRawStatus({
          gid: 'gid-private-true',
          bittorrent: {
            announceList: [],
            mode: 'single',
            info: { name: 'private' },
          },
        }),
      ])
      localRpc.tellWaiting = vi.fn(async () => [])
      localRpc.tellStopped = vi.fn(async () => [])

      await sm.restore()

      const task = tm.getById('m-private-true')
      expect(task?.bt?.isPrivate).toBe(true)
    })

    it('mergeTask injects saved.isPrivate=false into bt.isPrivate', async () => {
      const tm = new TaskManager()
      const localDb = createMockDb()
      const localRpc = createMockRpc()
      const sm = new SessionManager(tm, localRpc, localDb, createMockAdapter())
      seedAsPair(localDb, {
        motrixId: 'm-private-false',
        gid: 'gid-private-false',
        name: 'public.torrent',
        category: null,
        priority: 0,
        createdAt: 0,
        updatedAt: 0,
        diskPath: '/tmp',
        finalPath: '/tmp',
        finalName: 'public',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: null,
        infoHash: 'b'.repeat(40),
        uriHash: null,
        uris: [],
        status: TaskStatus.Downloading,
        isPrivate: false,
      })
      localRpc.tellActive = vi.fn(async () => [
        makeRawStatus({
          gid: 'gid-private-false',
          bittorrent: {
            announceList: [],
            mode: 'single',
            info: { name: 'public' },
          },
        }),
      ])
      localRpc.tellWaiting = vi.fn(async () => [])
      localRpc.tellStopped = vi.fn(async () => [])

      await sm.restore()

      const task = tm.getById('m-private-false')
      expect(task?.bt?.isPrivate).toBe(false)
    })

    it('mergeTask leaves bt undefined when aria2 reports no bittorrent block', async () => {
      const tm = new TaskManager()
      const localDb = createMockDb()
      const localRpc = createMockRpc()
      const sm = new SessionManager(tm, localRpc, localDb, createMockAdapter())
      seedAsPair(localDb, {
        motrixId: 'm-no-bt',
        gid: 'gid-no-bt',
        name: 'file.zip',
        category: null,
        priority: 0,
        createdAt: 0,
        updatedAt: 0,
        diskPath: '/tmp',
        finalPath: '/tmp',
        finalName: 'file.zip',
        transitionPhase: TransitionPhase.Idle,
        torrentMetaPath: null,
        infoHash: null,
        uriHash: null,
        uris: ['http://example.com/file.zip'],
        status: TaskStatus.Downloading,
        isPrivate: true,
      })
      localRpc.tellActive = vi.fn(async () => [
        makeRawStatus({ gid: 'gid-no-bt' /* no bittorrent block */ }),
      ])
      localRpc.tellWaiting = vi.fn(async () => [])
      localRpc.tellStopped = vi.fn(async () => [])

      await sm.restore()

      const task = tm.getById('m-no-bt')
      expect(task?.bt).toBeUndefined()
    })
  })
})

describe('restore() with task_instances (Plan A Task 7)', () => {
  it('matches aria2 GID against task_instances.gid first', async () => {
    const taskManager = new TaskManager()
    const db = createMockDb()
    const rpc = createMockRpc({
      activeTasks: [
        makeAria2Status({
          gid: 'g-1',
          status: 'active',
          totalLength: '1000',
          completedLength: '500',
        }),
      ],
    })
    const adapter = createMockAdapter()
    const sm = new SessionManager(taskManager, rpc, db, adapter)

    db.saveTaskWithInstances({
      task: makeTaskRow('m-1', TaskKind.Direct),
      instances: [
        makeInstanceRow('i-1', 'm-1', 'g-1', TaskInstancePhase.HttpDownload),
      ],
    })

    await sm.restore()

    const restored = taskManager.getById('m-1')
    expect(restored).toBeDefined()
    expect(restored?.engineTaskId).toBe('g-1')
    expect(restored?.instances).toHaveLength(1)
  })

  it('preserves all instances of a multi-instance task across restart', async () => {
    const taskManager = new TaskManager()
    const db = createMockDb()
    const rpc = createMockRpc({
      activeTasks: [
        makeAria2Status({ gid: 'g-seg-0', totalLength: '500' }),
        makeAria2Status({ gid: 'g-seg-1', totalLength: '500' }),
      ],
    })
    const adapter = createMockAdapter()
    const sm = new SessionManager(taskManager, rpc, db, adapter)

    db.saveTaskWithInstances({
      task: makeTaskRow('m-hls', TaskKind.Hls),
      instances: [
        makeInstanceRow(
          'i-seg-0',
          'm-hls',
          'g-seg-0',
          TaskInstancePhase.HlsSegment
        ),
        makeInstanceRow(
          'i-seg-1',
          'm-hls',
          'g-seg-1',
          TaskInstancePhase.HlsSegment
        ),
        makeInstanceRow('i-mux', 'm-hls', null, TaskInstancePhase.FfmpegMux),
      ],
    })

    await sm.restore()

    const restored = taskManager.getById('m-hls')
    expect(restored).toBeDefined()
    expect(restored?.instances).toHaveLength(3)
    expect(restored?.instances.map((i) => i.phase).sort()).toEqual([
      TaskInstancePhase.FfmpegMux,
      TaskInstancePhase.HlsSegment,
      TaskInstancePhase.HlsSegment,
    ])
  })

  it('orphan task with zero live aria2 GIDs becomes error when re-add fails', async () => {
    const taskManager = new TaskManager()
    const db = createMockDb()
    const rpc = createMockRpc({ activeTasks: [] })
    const adapter = createMockAdapter()
    adapter.createDownload = vi.fn().mockRejectedValue(new Error('refused'))
    const sm = new SessionManager(taskManager, rpc, db, adapter)

    db.saveTaskWithInstances({
      task: {
        ...makeTaskRow('m-orphan', TaskKind.Direct),
        finalPath: '/tmp/m-orphan.mp4',
        finalName: 'm-orphan.mp4',
      },
      instances: [
        {
          ...makeInstanceRow(
            'i-orphan',
            'm-orphan',
            'g-orphan',
            TaskInstancePhase.HttpDownload
          ),
          diskPath: '/tmp/m-orphan.mp4.motrix',
          uris: ['https://example.com/lost.mp4'],
          status: TaskStatus.Paused,
        },
      ],
    })

    await sm.restore()

    const restored = taskManager.getById('m-orphan')
    expect(restored?.status).toBe(TaskStatus.Error)
    const persisted = db.getTask('m-orphan')
    expect(persisted?.task).toMatchObject({
      aggStatus: TaskStatus.Error,
      finishedAt: restored?.finishedAt,
      errorDetailKey: 'task.recovery.startup.reAddFailed',
      errorMessage: null,
    })
    expect(persisted?.instances[0].status).toBe(TaskStatus.Error)

    const finishedAt = persisted?.task.finishedAt
    vi.mocked(adapter.createDownload).mockClear()
    const restartedTasks = new TaskManager()
    await new SessionManager(restartedTasks, rpc, db, adapter).restore()
    expect(adapter.createDownload).not.toHaveBeenCalled()
    expect(restartedTasks.getById('m-orphan')?.finishedAt).toBe(finishedAt)
  })

  it('completed tasks are retained without re-adding to aria2', async () => {
    const taskManager = new TaskManager()
    const db = createMockDb()
    const rpc = createMockRpc({ activeTasks: [] })
    const adapter = createMockAdapter()
    const sm = new SessionManager(taskManager, rpc, db, adapter)

    db.saveTaskWithInstances({
      task: {
        ...makeTaskRow('m-done', TaskKind.Direct),
        aggStatus: TaskStatus.Completed,
        finishedAt: 4242,
      },
      instances: [
        {
          ...makeInstanceRow(
            'i-done',
            'm-done',
            'g-done',
            TaskInstancePhase.HttpDownload
          ),
          status: TaskStatus.Completed,
        },
      ],
    })

    await sm.restore()

    const restored = taskManager.getById('m-done')
    expect(restored?.status).toBe(TaskStatus.Completed)
    expect(restored?.finishedAt).toBe(4242)
    expect(adapter.createDownload).not.toHaveBeenCalled()
  })

  it.each(Object.values(TaskType))(
    'save/restore retains terminal metadata and canonical type %s',
    async (taskType) => {
      const taskManager = new TaskManager()
      const db = createMockDb()
      const rpc = createMockRpc({ activeTasks: [] })
      const adapter = createMockAdapter()
      const sm = new SessionManager(taskManager, rpc, db, adapter)
      const torrentLike =
        taskType === TaskType.Bt || taskType === TaskType.Magnet
      taskManager.set(
        `m-${taskType}`,
        createTask({
          id: `m-${taskType}`,
          engineTaskId: `g-${taskType}`,
          type: taskType,
          kind: torrentLike ? TaskKind.Bt : TaskKind.Direct,
          status: TaskStatus.Error,
          finishedAt: 1234,
          errorMessage: 'network failed',
          errorCode: DownloadErrorCode.NetworkError,
          category: 'work',
          priority: 7,
          instances: [],
        })
      )

      await sm.save()
      await sm.restore()

      const restored = taskManager.getById(`m-${taskType}`)
      expect(restored).toMatchObject({
        type: taskType,
        status: TaskStatus.Error,
        finishedAt: 1234,
        errorMessage: 'network failed',
        errorCode: DownloadErrorCode.NetworkError,
        category: 'work',
        priority: 7,
      })
      expect(adapter.createDownload).not.toHaveBeenCalled()
      expect(adapter.addTorrent).not.toHaveBeenCalled()
    }
  )

  it('restore() re-issues metadata-only fetch for magnet_metadata_resolution instances', async () => {
    const taskManager = new TaskManager()
    const db = createMockDb()
    const rpc = createMockRpc({ activeTasks: [] })
    const adapter = createMockAdapter()
    // The metadata re-issue calls rpc.addUri directly (not adapter).
    ;(rpc as unknown as { addUri: ReturnType<typeof vi.fn> }).addUri = vi
      .fn()
      .mockResolvedValue('g-meta-new')
    const sm = new SessionManager(taskManager, rpc, db, adapter)

    db.saveTaskWithInstances({
      task: {
        ...makeTaskRow('m-mag', TaskKind.Bt),
        aggStatus: TaskStatus.FetchingMetadata,
        finalPath: '/Downloads',
      },
      instances: [
        {
          ...makeInstanceRow(
            'i-meta',
            'm-mag',
            'g-meta-old',
            TaskInstancePhase.MagnetMetadataResolution
          ),
          diskPath: '/tmp/motrix-magnet-metadata-xyz',
          uris: ['magnet:?xt=urn:btih:abc'],
          payload: { metadataDir: '/tmp/motrix-magnet-metadata-xyz' },
        },
      ],
    })

    await sm.restore()

    const addUri = (rpc as unknown as { addUri: ReturnType<typeof vi.fn> })
      .addUri
    expect(addUri).toHaveBeenCalledWith(
      ['magnet:?xt=urn:btih:abc'],
      expect.objectContaining({
        'bt-load-saved-metadata': 'false',
        'bt-metadata-only': 'true',
        dir: '/tmp/motrix-magnet-metadata-xyz',
        'follow-torrent': 'false',
      })
    )

    const restored = db.getTask('m-mag')
    expect(restored?.instances[0].gid).toBe('g-meta-new')

    const tmTask = taskManager.getById('m-mag')
    expect(tmTask?.status).toBe(TaskStatus.FetchingMetadata)
    expect(tmTask?.instances[0].phase).toBe(
      TaskInstancePhase.MagnetMetadataResolution
    )
    expect(adapter.addTorrent).not.toHaveBeenCalled()
    expect(adapter.createDownload).not.toHaveBeenCalled()
  })

  it('persists a failed magnet metadata re-issue before restore resolves', async () => {
    const taskManager = new TaskManager()
    const db = createMockDb()
    const rpc = createMockRpc({ activeTasks: [] })
    const addUri = vi.fn().mockRejectedValue(new Error('engine unavailable'))
    ;(rpc as unknown as { addUri: typeof addUri }).addUri = addUri
    const adapter = createMockAdapter()
    const sm = new SessionManager(taskManager, rpc, db, adapter)

    db.saveTaskWithInstances({
      task: {
        ...makeTaskRow('m-mag-failed', TaskKind.Bt),
        aggStatus: TaskStatus.FetchingMetadata,
        finalPath: '/Downloads',
      },
      instances: [
        {
          ...makeInstanceRow(
            'i-meta-failed',
            'm-mag-failed',
            'g-meta-old',
            TaskInstancePhase.MagnetMetadataResolution
          ),
          diskPath: '/tmp/motrix-magnet-metadata-failed',
          uris: ['magnet:?xt=urn:btih:failed'],
          payload: {
            metadataDir: '/tmp/motrix-magnet-metadata-failed',
            cleanupQuarantined: false,
          },
        },
      ],
    })

    await sm.restore()

    const persisted = db.getTask('m-mag-failed')
    expect(persisted?.task).toMatchObject({
      aggStatus: TaskStatus.Error,
      finishedAt: expect.any(Number),
      errorDetailKey: 'task.recovery.startup.reAddFailed',
      errorMessage: null,
    })
    expect(persisted?.instances[0].status).toBe(TaskStatus.Error)

    const finishedAt = persisted?.task.finishedAt
    addUri.mockClear()
    const restartedTasks = new TaskManager()
    await new SessionManager(restartedTasks, rpc, db, adapter).restore()
    expect(addUri).not.toHaveBeenCalled()
    expect(restartedTasks.getById('m-mag-failed')?.finishedAt).toBe(finishedAt)
  })

  it('restore() skips explicitly quarantined magnet metadata rows', async () => {
    // Quarantined tombstones (left by removeTask after a transient
    // aria2 cleanup failure) must NOT be re-added to TaskManager —
    // MagnetTracker.primeFromDatabase rebuilds the polling shield
    // from the DB row, but the task is gone from the user's view.
    const taskManager = new TaskManager()
    const db = createMockDb()
    const rpc = createMockRpc({ activeTasks: [] })
    const adapter = createMockAdapter()
    ;(rpc as unknown as { addUri: ReturnType<typeof vi.fn> }).addUri = vi
      .fn()
      .mockResolvedValue('g-meta-new')
    const sm = new SessionManager(taskManager, rpc, db, adapter)

    db.saveTaskWithInstances({
      task: {
        ...makeTaskRow('m-quarantine', TaskKind.Bt),
        aggStatus: TaskStatus.Error,
        finalPath: '/Downloads',
      },
      instances: [
        {
          ...makeInstanceRow(
            'i-meta',
            'm-quarantine',
            'g-meta-q',
            TaskInstancePhase.MagnetMetadataResolution
          ),
          status: TaskStatus.Error,
          diskPath: '/tmp/motrix-magnet-metadata-q',
          uris: ['magnet:?xt=urn:btih:q'],
          payload: {
            metadataDir: '/tmp/motrix-magnet-metadata-q',
            cleanupQuarantined: true,
            cleanupTombstoneHidden: true,
          },
        },
      ],
    })

    await sm.restore()

    // No metadata re-issue.
    const addUri = (rpc as unknown as { addUri: ReturnType<typeof vi.fn> })
      .addUri
    expect(addUri).not.toHaveBeenCalled()
    // Task hidden from Downloads UI.
    expect(taskManager.getById('m-quarantine')).toBeUndefined()
    // DB row preserved for MagnetTracker.primeFromDatabase.
    expect(db.getTask('m-quarantine')).not.toBeNull()
  })

  it('restore() retains a normal magnet metadata Error as visible history', async () => {
    const taskManager = new TaskManager()
    const db = createMockDb()
    const rpc = createMockRpc({
      activeTasks: [
        makeAria2Status({
          gid: 'g-meta-visible',
          status: 'active',
        }),
      ],
    })
    const adapter = createMockAdapter()
    const sm = new SessionManager(taskManager, rpc, db, adapter)

    db.saveTaskWithInstances({
      task: {
        ...makeTaskRow('m-visible-error', TaskKind.Bt),
        aggStatus: TaskStatus.Error,
        finishedAt: 4242,
        errorMessage: 'Magnet metadata fetch failed',
        errorCode: DownloadErrorCode.BtMetadataFailed,
      },
      instances: [
        {
          ...makeInstanceRow(
            'i-meta-visible',
            'm-visible-error',
            'g-meta-visible',
            TaskInstancePhase.MagnetMetadataResolution
          ),
          status: TaskStatus.Error,
          payload: {
            metadataDir: '/tmp/motrix-magnet-metadata-visible',
            // Cleanup itself exhausted its retry budget, but this was a
            // normal metadata failure rather than a user deletion.
            cleanupQuarantined: true,
            cleanupTombstoneHidden: false,
          },
        },
      ],
    })

    await sm.restore()

    expect(taskManager.getById('m-visible-error')).toMatchObject({
      status: TaskStatus.Error,
      finishedAt: 4242,
      errorMessage: 'Magnet metadata fetch failed',
      errorCode: DownloadErrorCode.BtMetadataFailed,
    })
  })

  it('restore() does not resurrect a live aria2 GID owned by a quarantine tombstone', async () => {
    const taskManager = new TaskManager()
    const db = createMockDb()
    const rpc = createMockRpc({
      activeTasks: [
        makeAria2Status({
          gid: 'g-quarantine-live',
          status: 'active',
          infoHash: 'a'.repeat(40),
        }),
      ],
    })
    const adapter = createMockAdapter()
    const sm = new SessionManager(taskManager, rpc, db, adapter)

    db.saveTaskWithInstances({
      task: {
        ...makeTaskRow('m-quarantine-live', TaskKind.Bt),
        aggStatus: TaskStatus.Error,
        infoHash: 'a'.repeat(40),
      },
      instances: [
        {
          ...makeInstanceRow(
            'i-quarantine-live',
            'm-quarantine-live',
            'g-quarantine-live',
            TaskInstancePhase.MagnetMetadataResolution
          ),
          status: TaskStatus.Error,
          payload: {
            metadataDir: '/tmp/motrix-magnet-metadata-live',
            cleanupQuarantined: true,
            cleanupTombstoneHidden: true,
          },
        },
      ],
    })

    await sm.restore()

    expect(taskManager.getById('m-quarantine-live')).toBeUndefined()
    expect(taskManager.getByEngineTaskId('g-quarantine-live')).toBeUndefined()
    expect(adapter.createDownload).not.toHaveBeenCalled()
    expect(adapter.addTorrent).not.toHaveBeenCalled()
  })
})
