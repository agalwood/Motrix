import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NOOP_TASK_ACTIVITY_RECORDER } from '@core/activity'
import type {
  AddTorrentParams,
  EngineAdapter,
} from '@core/engine/engine-adapter'
import { EventBus } from '@core/events/event-bus'
import {
  MotrixDatabase,
  type TaskFileRow,
  type TaskInstanceRow,
  type TaskRow,
} from '@core/session/motrix-database'
import { TaskManager } from '@core/task/task-manager'
import { taskRowToDownloadTask } from '@core/task/task-row-to-download-task'
import { TorrentMetaStoreImpl } from '@core/task/torrent-meta-store'
import { Events } from '@shared/protocol/events'
import {
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MagnetTracker } from './magnet-tracker'
import { swapMagnetMetadataForBt } from './swap-magnet-metadata-for-bt'

type FaultSeam = 'parent' | 'instances' | 'files'

interface TrackingAdapter {
  adapter: EngineAdapter
  allEngineGids: Set<string>
  addedGids: string[]
  forceRemoveTask: ReturnType<typeof vi.fn>
  removeDownloadResult: ReturnType<typeof vi.fn>
}

const tempRoots: string[] = []

function runImmediately<T>(
  _taskIds: readonly string[],
  operation: () => Promise<T>
): Promise<T> {
  return operation()
}

function persistImmediately<T>(operation: () => T | Promise<T>): Promise<T> {
  return Promise.resolve().then(operation)
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
      })
    )
  )
})

describe('swapMagnetMetadataForBt atomic commit', () => {
  it.each<FaultSeam>(['parent', 'instances', 'files'])(
    'rolls back the complete graph and compensates engine/files at the %s seam',
    async (seam) => {
      const root = await createTempRoot()
      const originalSaveDir = path.join(root, 'original-downloads')
      const saveDir = path.join(root, 'downloads')
      const torrentMetaDir = path.join(root, 'torrent-meta')
      await mkdir(originalSaveDir, { recursive: true })
      await mkdir(saveDir, { recursive: true })

      const db = new MotrixDatabase(':memory:')
      db.init()
      const taskId = 'm-atomic-swap'
      // The confirmation dialog permits changing the destination after
      // metadata resolution. Compensation must restore this original path
      // with the exact graph.
      const initialTask = makeMetadataReadyTask(taskId, originalSaveDir)
      const initialInstance = makeMetadataReadyInstance(taskId)
      const initialFiles: TaskFileRow[] = [
        {
          fileIndex: 7,
          path: '/old/selection.bin',
          size: 17,
          selected: true,
        },
      ]
      db.saveTaskWithInstances({
        task: initialTask,
        instances: [initialInstance],
      })
      db.replaceTaskFiles(taskId, initialFiles)

      const taskManager = new TaskManager()
      taskManager.set(
        taskId,
        taskRowToDownloadTask(initialTask, [initialInstance])
      )
      const eventBus = new EventBus()
      const taskUpdated = vi.fn()
      eventBus.on(Events.TaskUpdated, taskUpdated)
      const tracking = createTrackingAdapter()
      const recordTransition = vi.fn(async () => undefined)
      const torrentMetaStore = new TorrentMetaStoreImpl(torrentMetaDir)
      const magnetTracker = {
        cancel: vi.fn(async () => 'removed' as const),
        hasPendingSwapCleanup: vi.fn(() => false),
        reserveFailedSwapCleanup: vi.fn(),
        releaseFailedSwapCleanup: vi.fn(),
        registerFailedSwapCleanup: vi.fn(),
      } as unknown as MagnetTracker
      const finalNamePicker = {
        pick: vi.fn(async () => 'resolved.torrent'),
      }
      installFaultTrigger(db, seam, taskId)

      const input = {
        taskId,
        base64: Buffer.from('resolved torrent bytes').toString('base64'),
        selectedFiles: [0, 2],
        saveDir,
        name: 'resolved.torrent',
      }
      const deps = {
        db,
        taskManager,
        adapter: tracking.adapter,
        magnetTracker,
        finalNamePicker,
        torrentMetaStore,
        publishTaskUpdate: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        publishTaskUpdateNow: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        recordTransition,
        runTaskMutation: runImmediately,
        runExclusivePersistence: persistImmediately,
      }

      await expect(swapMagnetMetadataForBt(input, deps)).rejects.toThrow(
        `fault:${seam}`
      )
      const firstGid = tracking.addedGids[0]
      const fallbackMetaPath = path.join(torrentMetaDir, `${taskId}.torrent`)
      const fallbackTask = {
        ...initialTask,
        torrentMetaPath: fallbackMetaPath,
      }

      expect(db.getTask(taskId)).toEqual({
        task: fallbackTask,
        instances: [initialInstance],
      })
      expect(db.getTaskFiles(taskId)).toEqual(initialFiles)
      expect(taskManager.getAll()).toEqual([
        taskRowToDownloadTask(fallbackTask, [initialInstance]),
      ])
      expect(taskUpdated).not.toHaveBeenCalled()
      expect(recordTransition).not.toHaveBeenCalled()

      expect(tracking.allEngineGids).toEqual(new Set())
      expect(tracking.forceRemoveTask).toHaveBeenCalledWith(firstGid)
      expect(tracking.removeDownloadResult).toHaveBeenCalledWith(firstGid)
      expect(
        vi.mocked(magnetTracker.reserveFailedSwapCleanup).mock
          .invocationCallOrder[0]
      ).toBeLessThan(tracking.forceRemoveTask.mock.invocationCallOrder[0] ?? 0)
      expect(magnetTracker.releaseFailedSwapCleanup).toHaveBeenCalledWith(
        taskId,
        firstGid
      )
      await expectPathMissing(path.join(saveDir, 'resolved.torrent.motrix'))
      await expectPathExists(fallbackMetaPath)

      removeFaultTrigger(db, seam)
      await expect(swapMagnetMetadataForBt(input, deps)).resolves.toEqual({
        outcome: 'created',
        gid: expect.stringMatching(/^[0-9a-f]{16}$/),
        taskId,
      })
      const secondGid = tracking.addedGids[1]

      const committed = db.getTask(taskId)
      expect(committed?.task).toMatchObject({
        motrixId: taskId,
        taskType: TaskType.Bt,
        aggStatus: TaskStatus.Downloading,
      })
      expect(committed?.instances).toHaveLength(1)
      expect(committed?.instances[0]).toMatchObject({
        gid: secondGid,
        phase: TaskInstancePhase.BtDownload,
      })
      expect(db.getTaskFiles(taskId)).toEqual([
        { fileIndex: 0, path: '', size: 0, selected: true },
        { fileIndex: 2, path: '', size: 0, selected: true },
      ])
      expect(taskManager.getAll()).toHaveLength(1)
      expect(taskManager.getByEngineTaskId(firstGid)).toBeUndefined()
      expect(taskManager.getByEngineTaskId(secondGid)?.id).toBe(taskId)
      expect(tracking.allEngineGids).toEqual(new Set([secondGid]))
      expect(recordTransition).toHaveBeenCalledTimes(1)
      expect(taskUpdated).toHaveBeenCalledTimes(1)

      db.close()
    }
  )

  it.each<FaultSeam>(['parent', 'instances', 'files'])(
    'durably quarantines a new gid when the %s commit and compensation RPC both fail',
    async (seam) => {
      const root = await createTempRoot()
      const originalSaveDir = path.join(root, 'original-downloads')
      const saveDir = path.join(root, 'downloads')
      const torrentMetaDir = path.join(root, 'torrent-meta')
      await mkdir(originalSaveDir, { recursive: true })
      await mkdir(saveDir, { recursive: true })

      const db = new MotrixDatabase(':memory:')
      db.init()
      const taskId = `m-dual-failure-${seam}`
      const initialTask = makeMetadataReadyTask(taskId, originalSaveDir)
      const initialInstance = makeMetadataReadyInstance(taskId)
      const initialFiles: TaskFileRow[] = [
        {
          fileIndex: 7,
          path: '/old/selection.bin',
          size: 17,
          selected: true,
        },
      ]
      db.saveTaskWithInstances({
        task: initialTask,
        instances: [initialInstance],
      })
      db.replaceTaskFiles(taskId, initialFiles)

      const taskManager = new TaskManager()
      taskManager.set(
        taskId,
        taskRowToDownloadTask(initialTask, [initialInstance])
      )
      const eventBus = new EventBus()
      const taskUpdated = vi.fn(() => {
        throw new Error('quarantine publication listener failed')
      })
      eventBus.on(Events.TaskUpdated, taskUpdated)
      const tracking = createTrackingAdapter({ failCompensation: true })
      const recordTransition = vi.fn(async () => undefined)
      const torrentMetaStore = new TorrentMetaStoreImpl(torrentMetaDir)
      const registerFailedSwapCleanup = vi.fn()
      const magnetTracker = {
        cancel: vi.fn(async () => 'removed' as const),
        hasPendingSwapCleanup: vi.fn(() => false),
        reserveFailedSwapCleanup: vi.fn(),
        releaseFailedSwapCleanup: vi.fn(),
        registerFailedSwapCleanup,
      } as unknown as MagnetTracker
      const finalNamePicker = {
        pick: vi.fn(async () => 'resolved.torrent'),
      }
      installFaultTrigger(db, seam, taskId)

      const input = {
        taskId,
        base64: Buffer.from('resolved torrent bytes').toString('base64'),
        selectedFiles: [0, 2],
        saveDir,
        name: 'resolved.torrent',
      }
      const deps = {
        db,
        taskManager,
        adapter: tracking.adapter,
        magnetTracker,
        finalNamePicker,
        torrentMetaStore,
        publishTaskUpdate: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        publishTaskUpdateNow: () =>
          eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
        recordTransition,
        runTaskMutation: runImmediately,
        runExclusivePersistence: persistImmediately,
      }

      await expect(swapMagnetMetadataForBt(input, deps)).rejects.toThrow(
        `fault:${seam}`
      )
      const failedGid = tracking.addedGids[0]
      const fallbackMetaPath = path.join(torrentMetaDir, `${taskId}.torrent`)
      const fallbackTask = {
        ...initialTask,
        torrentMetaPath: fallbackMetaPath,
      }

      const tombstone = db.getTask(taskId)
      expect(tombstone?.task).toMatchObject({
        motrixId: taskId,
        aggStatus: TaskStatus.Error,
        taskType: TaskType.Magnet,
        finalPath: saveDir,
        errorMessage: 'Magnet swap cleanup is quarantined',
      })
      expect(tombstone?.instances).toHaveLength(1)
      expect(tombstone?.instances[0]).toMatchObject({
        gid: failedGid,
        phase: TaskInstancePhase.MagnetMetadataResolution,
        status: TaskStatus.Error,
        payload: {
          cleanupQuarantined: true,
          cleanupTombstoneHidden: true,
          cleanupArtifactPaths: [path.join(saveDir, 'resolved.torrent.motrix')],
        },
      })
      expect(db.getTaskFiles(taskId)).toEqual(initialFiles)
      expect(taskManager.getAll()).toEqual([])
      expect(taskUpdated).toHaveBeenCalledTimes(1)
      expect(recordTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId,
          previousStatus: TaskStatus.MetadataReady,
          nextStatus: TaskStatus.Error,
        })
      )
      expect(registerFailedSwapCleanup).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId,
          gid: failedGid,
          artifactPaths: [path.join(saveDir, 'resolved.torrent.motrix')],
        })
      )
      expect(
        vi.mocked(magnetTracker.reserveFailedSwapCleanup).mock
          .invocationCallOrder[0]
      ).toBeLessThan(tracking.forceRemoveTask.mock.invocationCallOrder[0] ?? 0)
      expect(magnetTracker.releaseFailedSwapCleanup).not.toHaveBeenCalled()

      expect(tracking.allEngineGids).toEqual(new Set([failedGid]))
      await expectPathExists(
        path.join(
          saveDir,
          'resolved.torrent.motrix',
          `${failedGid}.aria2-artifact`
        )
      )
      await expectPathExists(path.join(torrentMetaDir, `${taskId}.torrent`))

      vi.mocked(magnetTracker.hasPendingSwapCleanup).mockReturnValue(true)
      await expect(swapMagnetMetadataForBt(input, deps)).rejects.toMatchObject({
        code: 'MAGNET_CLEANUP_PENDING',
      })
      expect(vi.mocked(tracking.adapter.addTorrent).mock.calls).toHaveLength(1)

      // Simulate a fresh process after aria2 recovers. The tracker must read
      // the durable reservation, shield the reserved GID, clean artifacts,
      // and restore the exact pre-swap parent/instance/files identity.
      removeFaultTrigger(db, seam)
      const restartedTaskManager = new TaskManager()
      const restartedRpc = {
        forceRemove: vi.fn(async () => 'OK'),
        removeDownloadResult: vi.fn(async () => 'OK' as const),
        onDownloadComplete: vi.fn(() => vi.fn()),
        onBtDownloadComplete: vi.fn(() => vi.fn()),
        onDownloadError: vi.fn(() => vi.fn()),
      }
      const restartedTracker = new MagnetTracker(
        restartedRpc as never,
        new EventBus(),
        {
          getApp: vi.fn(() => ({ magnetFileSelection: true })),
          getEngine: vi.fn(() => ({ magnetResolveTimeout: 120 })),
        } as never,
        db,
        restartedTaskManager,
        { parse: vi.fn() } as never,
        NOOP_TASK_ACTIVITY_RECORDER,
        {
          torrentMetaDir,
          publishTaskUpdate: () => {},
          publishTaskUpdateNow: () => {},
        }
      )
      restartedTracker.primeFromDatabase()
      expect(restartedTracker.hasPendingSwapCleanup(taskId)).toBe(true)
      expect(
        restartedTracker.observe({ gid: failedGid, status: 'active' } as never)
      ).toBe(true)

      await expect(
        restartedTracker.cancel(taskId, { deleteTaskRow: false })
      ).resolves.toBe('removed')

      expect(restartedRpc.forceRemove).toHaveBeenCalledWith(failedGid)
      expect(restartedRpc.removeDownloadResult).toHaveBeenCalledWith(failedGid)
      expect(db.getTask(taskId)).toEqual({
        task: fallbackTask,
        instances: [initialInstance],
      })
      expect(db.getTaskFiles(taskId)).toEqual(initialFiles)
      expect(restartedTaskManager.getById(taskId)).toMatchObject({
        id: taskId,
        status: TaskStatus.MetadataReady,
        createdAt: initialTask.createdAt,
      })
      expect(restartedTracker.hasPendingSwapCleanup(taskId)).toBe(false)
      await expectPathMissing(path.join(saveDir, 'resolved.torrent.motrix'))
      await expectPathExists(fallbackMetaPath)
      await restartedTracker.stopAndDrain()

      db.close()
    }
  )

  it('creates no engine work when a persistent DB fault rejects the pre-add reservation', async () => {
    const root = await createTempRoot()
    const saveDir = path.join(root, 'downloads')
    const torrentMetaDir = path.join(root, 'torrent-meta')
    await mkdir(saveDir, { recursive: true })

    const db = new MotrixDatabase(':memory:')
    db.init()
    const taskId = 'm-reservation-persistent-fault'
    const initialTask = makeMetadataReadyTask(taskId, saveDir)
    const initialInstance = makeMetadataReadyInstance(taskId)
    const initialFiles: TaskFileRow[] = [
      { fileIndex: 7, path: '/old/selection.bin', size: 17, selected: true },
    ]
    db.saveTaskWithInstances({
      task: initialTask,
      instances: [initialInstance],
    })
    db.replaceTaskFiles(taskId, initialFiles)
    db.database.exec(`
      CREATE TEMP TRIGGER fail_new_reservation_instance
      BEFORE INSERT ON task_instances
      WHEN NEW.motrix_id = '${taskId}'
        AND NEW.gid <> '${initialInstance.gid}'
      BEGIN SELECT RAISE(ABORT, 'fault:persistent-reservation'); END
    `)

    const tracking = createTrackingAdapter({ failCompensation: true })
    const taskManager = new TaskManager()
    taskManager.set(
      taskId,
      taskRowToDownloadTask(initialTask, [initialInstance])
    )
    const eventBus = new EventBus()
    const taskUpdated = vi.fn()
    eventBus.on(Events.TaskUpdated, taskUpdated)
    const recordTransition = vi.fn(async () => undefined)
    const magnetTracker = {
      cancel: vi.fn(async () => 'removed' as const),
      hasPendingSwapCleanup: vi.fn(() => false),
      reserveFailedSwapCleanup: vi.fn(),
      releaseFailedSwapCleanup: vi.fn(),
      registerFailedSwapCleanup: vi.fn(),
    } as unknown as MagnetTracker

    await expect(
      swapMagnetMetadataForBt(
        {
          taskId,
          base64: Buffer.from('resolved torrent bytes').toString('base64'),
          selectedFiles: [0, 2],
          saveDir,
          name: 'resolved.torrent',
        },
        {
          db,
          taskManager,
          adapter: tracking.adapter,
          magnetTracker,
          finalNamePicker: {
            pick: vi.fn(async () => 'resolved.torrent'),
          },
          torrentMetaStore: new TorrentMetaStoreImpl(torrentMetaDir),
          publishTaskUpdate: () =>
            eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
          publishTaskUpdateNow: () =>
            eventBus.emit(Events.TaskUpdated, taskManager.getAll()),
          recordTransition,
          runTaskMutation: runImmediately,
          runExclusivePersistence: persistImmediately,
        }
      )
    ).rejects.toThrow('fault:persistent-reservation')

    expect(tracking.addedGids).toEqual([])
    expect(tracking.forceRemoveTask).not.toHaveBeenCalled()
    expect(tracking.removeDownloadResult).not.toHaveBeenCalled()
    expect(magnetTracker.reserveFailedSwapCleanup).toHaveBeenCalledOnce()
    expect(magnetTracker.releaseFailedSwapCleanup).toHaveBeenCalledOnce()
    const fallbackMetaPath = path.join(torrentMetaDir, `${taskId}.torrent`)
    const fallbackTask = {
      ...initialTask,
      torrentMetaPath: fallbackMetaPath,
    }
    expect(db.getTask(taskId)).toEqual({
      task: fallbackTask,
      instances: [initialInstance],
    })
    expect(db.getTaskFiles(taskId)).toEqual(initialFiles)
    expect(recordTransition).not.toHaveBeenCalled()
    expect(taskUpdated).not.toHaveBeenCalled()
    await expectPathMissing(path.join(saveDir, 'resolved.torrent.motrix'))
    await expectPathExists(fallbackMetaPath)

    // Simulate a restart after cancel removed the original metadataDir. The
    // durable torrent fallback keeps this restored MetadataReady selection
    // operable even though its temporary source has disappeared.
    const restartedEventBus = new EventBus()
    const selection = vi.fn()
    restartedEventBus.on(Events.MagnetFileSelection, selection)
    const parseTorrent = vi.fn(async () => ({
      name: 'resolved.torrent',
      infoHash: 'a'.repeat(40),
      totalSize: 17,
      files: [
        {
          index: 0,
          path: 'resolved.torrent',
          size: 17,
          extension: '.torrent',
        },
      ],
      comment: null,
      isPrivate: false,
    }))
    const restartedTracker = new MagnetTracker(
      {
        onDownloadComplete: vi.fn(() => vi.fn()),
        onBtDownloadComplete: vi.fn(() => vi.fn()),
        onDownloadError: vi.fn(() => vi.fn()),
      } as never,
      restartedEventBus,
      {
        getApp: vi.fn(() => ({ magnetFileSelection: true })),
        getEngine: vi.fn(() => ({ magnetResolveTimeout: 120 })),
      } as never,
      db,
      new TaskManager(),
      { parse: parseTorrent } as never,
      NOOP_TASK_ACTIVITY_RECORDER,
      {
        torrentMetaDir,
        publishTaskUpdate: () => {},
        publishTaskUpdateNow: () => {},
      }
    )

    await expect(restartedTracker.reopenFileSelection(taskId)).resolves.toBe(
      undefined
    )
    expect(parseTorrent).toHaveBeenCalledWith(
      Buffer.from('resolved torrent bytes').toString('base64')
    )
    expect(selection).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        torrentBase64: Buffer.from('resolved torrent bytes').toString('base64'),
      })
    )
    await restartedTracker.stopAndDrain()
    db.close()
  })
})

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-magnet-atomicity-'))
  tempRoots.push(root)
  return root
}

function createTrackingAdapter(options?: {
  failCompensation?: boolean
}): TrackingAdapter {
  const liveGids = new Set<string>()
  const resultGids = new Set<string>()
  const allEngineGids = new Set<string>()
  const addedGids: string[] = []

  const syncAllGids = (): void => {
    allEngineGids.clear()
    for (const gid of liveGids) allEngineGids.add(gid)
    for (const gid of resultGids) allEngineGids.add(gid)
  }

  const addTorrent = vi.fn(async (params: AddTorrentParams) => {
    const gid = params.gid
    if (!gid) throw new Error('test expected a caller-reserved gid')
    addedGids.push(gid)
    liveGids.add(gid)
    syncAllGids()
    await writeFile(path.join(params.saveDir, `${gid}.aria2-artifact`), gid)
    return gid
  })
  const forceRemoveTask = vi.fn(async (gid: string) => {
    if (options?.failCompensation) {
      throw new Error('force-remove transport unavailable')
    }
    liveGids.delete(gid)
    resultGids.add(gid)
    syncAllGids()
  })
  const removeDownloadResult = vi.fn(async (gid: string) => {
    if (options?.failCompensation) {
      throw new Error('remove-result transport unavailable')
    }
    resultGids.delete(gid)
    syncAllGids()
  })

  return {
    adapter: {
      addTorrent,
      getTaskFiles: vi.fn(async () => []),
      forceRemoveTask,
      removeDownloadResult,
    } as unknown as EngineAdapter,
    allEngineGids,
    addedGids,
    forceRemoveTask,
    removeDownloadResult,
  }
}

function installFaultTrigger(
  db: MotrixDatabase,
  seam: FaultSeam,
  taskId: string
): void {
  const triggerName = faultTriggerName(seam)
  const escapedTaskId = taskId.replaceAll("'", "''")
  const statement =
    seam === 'parent'
      ? `CREATE TEMP TRIGGER ${triggerName}
         BEFORE UPDATE ON tasks
         WHEN OLD.motrix_id = '${escapedTaskId}'
           AND NEW.agg_status = 'downloading'
         BEGIN SELECT RAISE(ABORT, 'fault:${seam}'); END`
      : seam === 'instances'
        ? `CREATE TEMP TRIGGER ${triggerName}
           BEFORE INSERT ON task_instances
           WHEN NEW.motrix_id = '${escapedTaskId}'
             AND NEW.phase = 'bt_download'
           BEGIN SELECT RAISE(ABORT, 'fault:${seam}'); END`
        : `CREATE TEMP TRIGGER ${triggerName}
           BEFORE INSERT ON task_files
           WHEN NEW.motrix_id = '${escapedTaskId}'
             AND NEW.file_index IN (0, 2)
           BEGIN SELECT RAISE(ABORT, 'fault:${seam}'); END`
  db.database.exec(statement)
}

function removeFaultTrigger(db: MotrixDatabase, seam: FaultSeam): void {
  db.database.exec(`DROP TRIGGER ${faultTriggerName(seam)}`)
}

function faultTriggerName(seam: FaultSeam): string {
  return `fail_magnet_swap_${seam}`
}

async function expectPathMissing(target: string): Promise<void> {
  await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' })
}

async function expectPathExists(target: string): Promise<void> {
  await expect(access(target)).resolves.toBeUndefined()
}

function makeMetadataReadyTask(taskId: string, saveDir: string): TaskRow {
  return {
    motrixId: taskId,
    name: '[METADATA] resolved.torrent',
    kind: TaskKind.Bt,
    taskType: TaskType.Magnet,
    category: null,
    priority: 0,
    tags: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    finalPath: saveDir,
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

function makeMetadataReadyInstance(taskId: string): TaskInstanceRow {
  return {
    instanceId: `metadata:${taskId}`,
    motrixId: taskId,
    gid: 'g-metadata',
    phase: TaskInstancePhase.MagnetMetadataResolution,
    status: TaskStatus.MetadataReady,
    progress: 100,
    totalBytes: 0,
    downloadedBytes: 0,
    uploadedBytes: 0,
    diskPath: '/tmp/motrix-metadata',
    transitionPhase: TransitionPhase.Idle,
    uris: ['magnet:?xt=urn:btih:atomicity'],
    uriHash: null,
    payload: { metadataDir: '/tmp/motrix-metadata' },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
  }
}
