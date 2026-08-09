import fs from 'node:fs'
import type { Aria2RpcClient } from '@core/engine/aria2/aria2-rpc-client'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import { EventBus } from '@core/events/event-bus'
import {
  TaskInspectorActivityRuntime,
  type TaskInspectorActivityRuntimePersistence,
} from '@core/inspector-activity'
import type { Logger } from '@core/logger'
import { TaskKind, TaskStatus, TaskType } from '@shared/types/task'
import type {
  TaskActivityCheckpoint,
  TaskHistoryEventInput,
} from '@shared/types/task-inspector-activity'
import { makeDownloadTask } from '@test-utils/task'
import { directTaskUpdatePublication } from '@test-utils/task-update'
import { describe, expect, it, vi } from 'vitest'
import type { MotrixDatabase } from '../../session/motrix-database'
import { SessionManager } from '../../session/session-manager'
import type { MagnetTracker } from '../../torrent/magnet-tracker'
import type { FileCleanupService } from '../file-cleanup-service'
import { TaskManager } from '../task-manager'
import type { TorrentMetaStore } from '../torrent-meta-store'
import {
  type ClearStoppedTasksDeps,
  clearStoppedTasks,
} from './clear-stopped-tasks'
import { pauseTask } from './pause-task'
import { reAddTask } from './re-add-task'
import { type RemoveTaskDeps, removeTask } from './remove-task'
import type { TaskActionDeps } from './shared'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve
  })
  return { promise, resolve }
}

function activityStore(): TaskInspectorActivityRuntimePersistence {
  return {
    ensureTask: vi.fn(),
    checkpointBatch: vi.fn((_inputs: readonly TaskActivityCheckpoint[]) => ({
      revisions: [],
      omissions: [],
    })),
    recordTransition: vi.fn((_input: TaskHistoryEventInput) => null),
    snapshot: vi.fn(() => null),
  }
}

function logger(): Logger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as Logger
}

function task(status: TaskStatus) {
  return makeDownloadTask({
    id: 'task-1',
    engineTaskId: 'gid-1',
    status,
    type: TaskType.Http,
    uris: ['https://example.test/file'],
    diskPath: '/downloads/file.motrix',
    saveDir: '/downloads',
  })
}

/**
 * The re-add races need a task that actually clears reAddTask's capability
 * gate. `canRebuildTaskInputs` admits only torrent-like tasks with a
 * persisted sidecar, so these fixtures are BT — the race being tested
 * (mutation-lock ordering between re-add and remove) is task-type agnostic.
 */
function retryableTask(status: TaskStatus) {
  return makeDownloadTask({
    id: 'task-1',
    engineTaskId: 'gid-1',
    status,
    type: TaskType.Bt,
    kind: TaskKind.Bt,
    torrentMetaPath: '/sidecar/task-1.torrent',
    diskPath: '/downloads/file.motrix',
    saveDir: '/downloads',
  })
}

function actionDeps(
  taskManager: TaskManager,
  eventBus: EventBus,
  runtime: TaskInspectorActivityRuntime,
  adapter: EngineAdapter,
  durable: Map<string, ReturnType<typeof task>>
): TaskActionDeps & {
  persistTask: NonNullable<TaskActionDeps['persistTask']>
  runTaskMutation: NonNullable<TaskActionDeps['runTaskMutation']>
} {
  return {
    taskManager,
    adapter,
    eventBus,
    log: logger(),
    persistTask: async (next) => {
      durable.set(next.id, structuredClone(next))
    },
    ...directTaskUpdatePublication({ eventBus, taskManager }),
    recordTransition: (input) => runtime.recordTransition(input),
    runTaskMutation: (taskIds, operation) =>
      runtime.runTaskMutation(taskIds, operation),
  }
}

describe('canonical task mutation serialization', () => {
  it('does not orphan a replacement gid when remove is admitted before re-add', async () => {
    const removeGate = deferred()
    const removeStarted = deferred()
    const taskManager = new TaskManager()
    const initial = retryableTask(TaskStatus.Error)
    taskManager.add(initial)
    const durable = new Map([[initial.id, structuredClone(initial)]])
    const liveGids = new Set([initial.engineTaskId])
    const eventBus = new EventBus()
    const runtime = new TaskInspectorActivityRuntime(activityStore(), eventBus)
    const adapter = {
      removeDownloadResult: vi.fn(async (gid: string) => {
        removeStarted.resolve()
        await removeGate.promise
        liveGids.delete(gid)
      }),
      getEngineTaskOptions: vi.fn(async () => null),
      forceRemoveTask: vi.fn(async (gid: string) => {
        liveGids.delete(gid)
      }),
      addTorrent: vi.fn(async ({ gid }: { gid?: string }) => {
        if (!gid) throw new Error('missing reserved gid')
        liveGids.add(gid)
        return gid
      }),
    } as unknown as EngineAdapter
    const shared = actionDeps(taskManager, eventBus, runtime, adapter, durable)
    const removeDeps: RemoveTaskDeps = {
      ...shared,
      fileCleanupService: {
        cleanup: vi.fn(async () => undefined),
      } as FileCleanupService,
      torrentMetaStore: {
        read: vi.fn(async () => new Uint8Array()),
        remove: vi.fn(async () => undefined),
      } as unknown as TorrentMetaStore,
      db: {
        deleteTask: (taskId) => {
          durable.delete(taskId)
        },
        getTask: vi.fn(() => null),
        saveTaskWithInstances: vi.fn(),
      },
      magnetTracker: {} as MagnetTracker,
      taskPersistence: {
        runExclusivePersistence: async (operation) => operation(),
      },
      deleteParentTasks: (taskIds, deleteParents) =>
        runtime.deleteParentTasks(taskIds, deleteParents),
    }

    const removing = removeTask(
      initial.id,
      { deleteWithFiles: false },
      removeDeps
    )
    await removeStarted.promise

    // reAddTask reads synchronously before its first adapter await in the
    // unsafe implementation. Releasing remove after this call therefore
    // deterministically exercises both possible late schedules: re-add may
    // publish first, or it may lose the stale-commit check after deletion.
    const readding = reAddTask(initial.id, {
      ...shared,
      torrentMetaStore: removeDeps.torrentMetaStore,
    })
    removeGate.resolve()
    await Promise.all([removing, readding])

    expect(adapter.addTorrent).not.toHaveBeenCalled()
    expect(liveGids).toEqual(new Set())
    expect(durable.has(initial.id)).toBe(false)
    expect(taskManager.getById(initial.id)).toBeUndefined()
  })

  it('removes the replacement gid when re-add is admitted before remove', async () => {
    const addGate = deferred()
    const addStarted = deferred()
    const taskManager = new TaskManager()
    const initial = retryableTask(TaskStatus.Error)
    taskManager.add(initial)
    const durable = new Map([[initial.id, structuredClone(initial)]])
    const liveGids = new Set([initial.engineTaskId])
    const eventBus = new EventBus()
    const runtime = new TaskInspectorActivityRuntime(activityStore(), eventBus)
    const adapter = {
      getEngineTaskOptions: vi.fn(async () => null),
      forceRemoveTask: vi.fn(async (gid: string) => {
        liveGids.delete(gid)
      }),
      removeDownloadResult: vi.fn(async (gid: string) => {
        liveGids.delete(gid)
      }),
      addTorrent: vi.fn(async ({ gid }: { gid?: string }) => {
        addStarted.resolve()
        await addGate.promise
        if (!gid) throw new Error('missing reserved gid')
        liveGids.add(gid)
        return gid
      }),
    } as unknown as EngineAdapter
    const shared = actionDeps(taskManager, eventBus, runtime, adapter, durable)
    const torrentMetaStore = {
      read: vi.fn(async () => new Uint8Array()),
      remove: vi.fn(async () => undefined),
    } as unknown as TorrentMetaStore
    const removeDeps: RemoveTaskDeps = {
      ...shared,
      fileCleanupService: {
        cleanup: vi.fn(async () => undefined),
      } as FileCleanupService,
      torrentMetaStore,
      db: {
        deleteTask: (taskId) => {
          durable.delete(taskId)
        },
        getTask: vi.fn(() => null),
        saveTaskWithInstances: vi.fn(),
      },
      magnetTracker: {} as MagnetTracker,
      taskPersistence: {
        runExclusivePersistence: async (operation) => operation(),
      },
      deleteParentTasks: (taskIds, deleteParents) =>
        runtime.deleteParentTasks(taskIds, deleteParents),
    }

    const readding = reAddTask(initial.id, {
      ...shared,
      torrentMetaStore,
    })
    await addStarted.promise
    const removing = removeTask(
      initial.id,
      { deleteWithFiles: false },
      removeDeps
    )

    addGate.resolve()
    await Promise.all([readding, removing])

    expect(adapter.forceRemoveTask).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f]{16}$/)
    )
    expect(liveGids).toEqual(new Set())
    expect(durable.has(initial.id)).toBe(false)
    expect(taskManager.getById(initial.id)).toBeUndefined()
  })

  it('does not resurrect a task when a deferred pause loses to remove', async () => {
    const pauseGate = deferred()
    const pauseStarted = deferred()
    const taskManager = new TaskManager()
    const initial = task(TaskStatus.Downloading)
    taskManager.add(initial)
    const durable = new Map([[initial.id, structuredClone(initial)]])
    const eventBus = new EventBus()
    const runtime = new TaskInspectorActivityRuntime(activityStore(), eventBus)
    const adapter = {
      pauseTask: vi.fn(async () => {
        pauseStarted.resolve()
        await pauseGate.promise
      }),
      getTaskStatus: vi.fn(async () => null),
      forceRemoveTask: vi.fn(async () => undefined),
      removeDownloadResult: vi.fn(async () => undefined),
    } as unknown as EngineAdapter
    const shared = actionDeps(taskManager, eventBus, runtime, adapter, durable)
    const removeDeps: RemoveTaskDeps = {
      ...shared,
      fileCleanupService: {
        cleanup: vi.fn(async () => undefined),
      } as FileCleanupService,
      torrentMetaStore: {
        remove: vi.fn(async () => undefined),
      } as unknown as TorrentMetaStore,
      db: {
        deleteTask: (taskId) => {
          durable.delete(taskId)
        },
        getTask: vi.fn(() => null),
        saveTaskWithInstances: vi.fn(),
      },
      magnetTracker: {} as MagnetTracker,
      taskPersistence: {
        runExclusivePersistence: async (operation) => operation(),
      },
      deleteParentTasks: (taskIds, deleteParents) =>
        runtime.deleteParentTasks(taskIds, deleteParents),
    }

    const pausing = pauseTask(initial.id, shared)
    await pauseStarted.promise
    await removeTask(initial.id, { deleteWithFiles: false }, removeDeps)

    expect(durable.has(initial.id)).toBe(false)
    expect(taskManager.getById(initial.id)).toBeUndefined()

    pauseGate.resolve()
    await pausing

    expect(durable.has(initial.id)).toBe(false)
    expect(taskManager.getById(initial.id)).toBeUndefined()
  })

  it('waits behind an in-flight info-hash derivation so its stale batch cannot resurrect a removed task', async () => {
    const readStarted = deferred()
    const allowRead = deferred()
    const taskManager = new TaskManager()
    const initial = makeDownloadTask({
      ...task(TaskStatus.Completed),
      type: TaskType.Bt,
      kind: TaskKind.Bt,
      torrentMetaPath: '/tmp/remove-save-race.torrent',
      infoHash: null,
    })
    taskManager.add(initial)

    const durableIds = new Set([initial.id])
    const persistenceOrder: string[] = []
    const db = {
      saveTasksBatch: vi.fn((rows: Array<{ task: { motrixId: string } }>) => {
        persistenceOrder.push('stale-save')
        for (const row of rows) durableIds.add(row.task.motrixId)
      }),
      deleteTask: vi.fn((taskId: string) => {
        persistenceOrder.push('delete')
        durableIds.delete(taskId)
      }),
      getTask: vi.fn(() => null),
      saveTaskWithInstances: vi.fn(),
    } as unknown as MotrixDatabase
    const adapter = {
      forceRemoveTask: vi.fn(async () => undefined),
      removeDownloadResult: vi.fn(async () => undefined),
    } as unknown as EngineAdapter
    const session = new SessionManager(
      taskManager,
      {} as Aria2RpcClient,
      db,
      adapter
    )
    const eventBus = new EventBus()
    const runtime = new TaskInspectorActivityRuntime(activityStore(), eventBus)
    const readFileSpy = vi
      .spyOn(fs.promises, 'readFile')
      .mockImplementation((async () => {
        readStarted.resolve()
        await allowRead.promise
        return Buffer.from('not-a-torrent')
      }) as unknown as typeof fs.promises.readFile)

    const saving = session.save()
    let removing: Promise<void> | undefined
    try {
      await readStarted.promise
      const removeDeps: RemoveTaskDeps = {
        taskManager,
        adapter,
        eventBus,
        log: logger(),
        ...directTaskUpdatePublication({ eventBus, taskManager }),
        fileCleanupService: {
          cleanup: vi.fn(async () => undefined),
        } as FileCleanupService,
        torrentMetaStore: {
          remove: vi.fn(async () => undefined),
        } as unknown as TorrentMetaStore,
        db,
        magnetTracker: {} as MagnetTracker,
        taskPersistence: session,
        deleteParentTasks: (taskIds, deleteParents) =>
          runtime.deleteParentTasks(taskIds, deleteParents),
        runTaskMutation: (taskIds, operation) =>
          runtime.runTaskMutation(taskIds, operation),
      }
      removing = removeTask(initial.id, { deleteWithFiles: false }, removeDeps)

      await Promise.resolve()
      await Promise.resolve()
      expect(db.deleteTask).not.toHaveBeenCalled()

      allowRead.resolve()
      await Promise.all([saving, removing])
    } finally {
      allowRead.resolve()
      await saving.catch(() => undefined)
      await removing?.catch(() => undefined)
      readFileSpy.mockRestore()
    }

    expect(persistenceOrder).toEqual(['stale-save', 'delete'])
    expect(durableIds.has(initial.id)).toBe(false)
    expect(taskManager.getById(initial.id)).toBeUndefined()
  })

  it('purges tellStopped so restart cannot adopt the removed gid under a fresh public id', async () => {
    const taskManager = new TaskManager()
    const initial = task(TaskStatus.Completed)
    taskManager.add(initial)
    const stoppedRows = new Map([
      [
        initial.engineTaskId,
        {
          gid: initial.engineTaskId,
          status: 'complete' as const,
          totalLength: '100',
          completedLength: '100',
          uploadLength: '0',
          downloadSpeed: '0',
          uploadSpeed: '0',
          connections: '0',
          numSeeders: '0',
          seeder: 'false',
          pieceLength: '0',
          numPieces: '0',
          dir: '/downloads',
          files: [
            {
              index: '1',
              path: '/downloads/file.motrix',
              length: '100',
              completedLength: '100',
              selected: 'true',
              uris: [
                {
                  uri: 'https://example.test/file',
                  status: 'used' as const,
                },
              ],
            },
          ],
        },
      ],
    ])
    const adapter = {
      removeDownloadResult: vi.fn(async (gid: string) => {
        stoppedRows.delete(gid)
      }),
    } as unknown as EngineAdapter
    const eventBus = new EventBus()
    const runtime = new TaskInspectorActivityRuntime(activityStore(), eventBus)
    const db = {
      deleteTask: vi.fn(),
      getTask: vi.fn(() => null),
      saveTaskWithInstances: vi.fn(),
    }

    await removeTask(
      initial.id,
      { deleteWithFiles: false },
      {
        taskManager,
        adapter,
        eventBus,
        log: logger(),
        ...directTaskUpdatePublication({ eventBus, taskManager }),
        fileCleanupService: {
          cleanup: vi.fn(async () => undefined),
        } as FileCleanupService,
        torrentMetaStore: {
          remove: vi.fn(async () => undefined),
        } as unknown as TorrentMetaStore,
        db,
        magnetTracker: {} as MagnetTracker,
        taskPersistence: {
          runExclusivePersistence: async (operation) => operation(),
        },
        deleteParentTasks: (taskIds, deleteParents) =>
          runtime.deleteParentTasks(taskIds, deleteParents),
        runTaskMutation: (taskIds, operation) =>
          runtime.runTaskMutation(taskIds, operation),
      }
    )

    const restartedTasks = new TaskManager()
    const restartDb = {
      getAllTasks: vi.fn(() => []),
      getTaskFiles: vi.fn(() => []),
    } as unknown as MotrixDatabase
    const restartRpc = {
      tellActive: vi.fn(async () => []),
      tellWaiting: vi.fn(async () => []),
      tellStopped: vi.fn(async () => [...stoppedRows.values()]),
    } as unknown as Aria2RpcClient
    const restartedSession = new SessionManager(
      restartedTasks,
      restartRpc,
      restartDb,
      {} as EngineAdapter
    )

    await restartedSession.restore()

    expect(adapter.removeDownloadResult).toHaveBeenCalledWith(
      initial.engineTaskId
    )
    expect(stoppedRows.size).toBe(0)
    expect(restartedTasks.getAll()).toEqual([])
  })

  it('does not resurrect a terminal task when a deferred pause loses to clear', async () => {
    const pauseGate = deferred()
    const pauseStarted = deferred()
    const taskManager = new TaskManager()
    const initial = task(TaskStatus.Completed)
    taskManager.add(initial)
    const durable = new Map([[initial.id, structuredClone(initial)]])
    const eventBus = new EventBus()
    const runtime = new TaskInspectorActivityRuntime(activityStore(), eventBus)
    const adapter = {
      pauseTask: vi.fn(async () => {
        pauseStarted.resolve()
        await pauseGate.promise
      }),
      getTaskStatus: vi.fn(async () => null),
      removeDownloadResult: vi.fn(async () => undefined),
      removeDownloadResults: vi.fn(async (gids: readonly string[]) =>
        gids.map(() => ({ status: 'fulfilled' as const, value: undefined }))
      ),
    } as unknown as EngineAdapter
    const shared = actionDeps(taskManager, eventBus, runtime, adapter, durable)
    const clearDeps: ClearStoppedTasksDeps = {
      taskManager,
      adapter,
      db: {
        deleteTasks: (taskIds) => {
          for (const taskId of taskIds) durable.delete(taskId)
        },
      },
      taskPersistence: {
        runExclusivePersistence: async (operation) => operation(),
      },
      eventBus,
      log: logger(),
      publishTaskUpdateNow: directTaskUpdatePublication({
        eventBus,
        taskManager,
      }).publishTaskUpdateNow,
      deleteParentTasks: (taskIds, deleteParents) =>
        runtime.deleteParentTasks(taskIds, deleteParents),
    }

    const pausing = pauseTask(initial.id, shared)
    await pauseStarted.promise
    await clearStoppedTasks(clearDeps)

    expect(durable.has(initial.id)).toBe(false)
    expect(taskManager.getById(initial.id)).toBeUndefined()

    pauseGate.resolve()
    await pausing

    expect(durable.has(initial.id)).toBe(false)
    expect(taskManager.getById(initial.id)).toBeUndefined()
  })

  it('takes the Activity task lock before Session persistence to avoid a clear-pause deadlock', async () => {
    const pauseGate = deferred()
    const pauseStarted = deferred()
    const clearHasSession = deferred()
    const allowClearOperation = deferred()
    const taskManager = new TaskManager()
    const initial = task(TaskStatus.Completed)
    taskManager.add(initial)
    const durable = new Map([[initial.id, structuredClone(initial)]])
    const eventBus = new EventBus()
    const runtime = new TaskInspectorActivityRuntime(activityStore(), eventBus)
    const adapter = {
      pauseTask: vi.fn(async () => {
        pauseStarted.resolve()
        await pauseGate.promise
      }),
      getTaskStatus: vi.fn(async () => null),
      removeDownloadResult: vi.fn(async () => undefined),
      removeDownloadResults: vi.fn(async (gids: readonly string[]) =>
        gids.map(() => ({ status: 'fulfilled' as const, value: undefined }))
      ),
    } as unknown as EngineAdapter

    let persistenceTail = Promise.resolve()
    let firstPersistence = true
    const runExclusivePersistence = <T>(
      operation: () => T | Promise<T>
    ): Promise<T> => {
      const result = persistenceTail.then(async () => {
        if (firstPersistence) {
          firstPersistence = false
          clearHasSession.resolve()
          await allowClearOperation.promise
        }
        return operation()
      })
      persistenceTail = result.then(
        () => undefined,
        () => undefined
      )
      return result
    }
    const shared: TaskActionDeps = {
      taskManager,
      adapter,
      eventBus,
      log: logger(),
      ...directTaskUpdatePublication({ eventBus, taskManager }),
      persistTask: (next) =>
        runExclusivePersistence(() => {
          durable.set(next.id, structuredClone(next))
        }),
      recordTransition: (input) => runtime.recordTransition(input),
      runTaskMutation: (taskIds, operation) =>
        runtime.runTaskMutation(taskIds, operation),
    }
    const clearDeps: ClearStoppedTasksDeps = {
      taskManager,
      adapter,
      db: {
        deleteTasks: (taskIds) => {
          for (const taskId of taskIds) durable.delete(taskId)
        },
      },
      taskPersistence: { runExclusivePersistence },
      eventBus,
      log: logger(),
      publishTaskUpdateNow: directTaskUpdatePublication({
        eventBus,
        taskManager,
      }).publishTaskUpdateNow,
      deleteParentTasks: (taskIds, deleteParents) =>
        runtime.deleteParentTasks(taskIds, deleteParents),
      runTaskMutation: (taskIds, operation) =>
        runtime.runTaskMutation(taskIds, operation),
    }

    const pausing = pauseTask(initial.id, shared)
    await pauseStarted.promise
    const clearing = clearStoppedTasks(clearDeps)
    await clearHasSession.promise

    pauseGate.resolve()
    await Promise.resolve()
    await Promise.resolve()
    allowClearOperation.resolve()

    const completed = await Promise.race([
      Promise.all([pausing, clearing]).then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ])

    expect(completed).toBe(true)
    expect(durable.has(initial.id)).toBe(false)
    expect(taskManager.getById(initial.id)).toBeUndefined()
  })
})
