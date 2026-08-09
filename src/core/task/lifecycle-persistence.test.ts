import type { Aria2RpcClient } from '@core/engine/aria2/aria2-rpc-client'
import type { Aria2RawStatus } from '@core/engine/aria2/types'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import { MotrixDatabase } from '@core/session/motrix-database'
import { SessionManager } from '@core/session/session-manager'
import { mergeEngineTask } from '@core/task/merge-engine-task'
import type { DownloadTask, TaskInstance } from '@shared/types/task'
import {
  makeDefaultBtExtension,
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type FinalizeTaskDeps, finalizeTask } from './actions/finalize-task'
import { TaskManager } from './task-manager'
import {
  type RecoveryDeps,
  type RecoveryFs,
  TaskRecoveryServiceImpl,
} from './task-recovery-service'

const openDatabases: MotrixDatabase[] = []

afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close()
})

function makeInstance(
  taskId: string,
  phase: TaskInstancePhase,
  overrides: Partial<TaskInstance> = {}
): TaskInstance {
  return {
    instanceId: `primary:${taskId}`,
    motrixId: taskId,
    gid: 'gid-old',
    phase,
    status: TaskStatus.Downloading,
    progress: 100,
    totalBytes: 1_000,
    downloadedBytes: 1_000,
    uploadedBytes: 0,
    diskPath: '/downloads/output.motrix',
    transitionPhase: TransitionPhase.Idle,
    uris: ['https://example.com/output'],
    uriHash: null,
    payload: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

function makeSingleInstanceTask(
  overrides: Partial<DownloadTask> = {}
): DownloadTask {
  const taskId = overrides.id ?? 'lifecycle-task'
  const type = overrides.type ?? TaskType.Http
  const isBt = type === TaskType.Bt || type === TaskType.Magnet
  const task = makeDownloadTask({
    id: taskId,
    engineTaskId: 'gid-old',
    name: 'output',
    kind: isBt ? TaskKind.Bt : TaskKind.Direct,
    type,
    status: TaskStatus.Downloading,
    progress: 1,
    totalBytes: 1_000,
    downloadedBytes: 1_000,
    sizeWhenDone: 1_000,
    saveDir: '/downloads',
    diskPath: '/downloads/output.motrix',
    finalPath: '/downloads/output',
    finalName: 'output',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    infoHash: isBt ? 'ABC123' : null,
    torrentMetaPath: isBt ? '/state/lifecycle-task.torrent' : null,
    bt: isBt ? makeDefaultBtExtension() : undefined,
    ...overrides,
  })
  if (overrides.instances === undefined) {
    task.instances = [
      makeInstance(
        task.id,
        isBt ? TaskInstancePhase.BtDownload : TaskInstancePhase.HttpDownload,
        {
          gid: task.engineTaskId,
          status: task.status,
          diskPath: task.diskPath,
          transitionPhase: task.transitionPhase,
          uris: task.uris,
        }
      ),
    ]
  }
  return task
}

function makePersistenceHarness(task: DownloadTask): {
  db: MotrixDatabase
  taskManager: TaskManager
  sessionManager: SessionManager
  persist: (task: DownloadTask) => Promise<void>
} {
  const db = new MotrixDatabase(':memory:')
  db.init()
  openDatabases.push(db)
  const taskManager = new TaskManager()
  taskManager.add(task)
  const sessionManager = new SessionManager(
    taskManager,
    {} as Aria2RpcClient,
    db,
    {} as EngineAdapter
  )
  return {
    db,
    taskManager,
    sessionManager,
    persist: (nextTask) => sessionManager.persistTask(nextTask),
  }
}

function makeRawStatus(
  gid: string,
  overrides: Partial<Aria2RawStatus> = {}
): Aria2RawStatus {
  return {
    gid,
    status: 'active',
    totalLength: '1000',
    completedLength: '1000',
    uploadLength: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    connections: '0',
    numSeeders: '0',
    seeder: 'false',
    pieceLength: '0',
    numPieces: '0',
    dir: '/downloads',
    files: [],
    ...overrides,
  }
}

async function restoreFromDatabase(
  db: MotrixDatabase,
  statuses: Aria2RawStatus[]
): Promise<TaskManager> {
  const restoredTasks = new TaskManager()
  const rpc = {
    tellActive: vi.fn(async () => statuses),
    tellWaiting: vi.fn(async () => []),
    tellStopped: vi.fn(async () => []),
  } as unknown as Aria2RpcClient
  const session = new SessionManager(
    restoredTasks,
    rpc,
    db,
    {} as EngineAdapter
  )
  await session.restore()
  return restoredTasks
}

async function restoreRuntimeFromDatabase(db: MotrixDatabase): Promise<{
  taskManager: TaskManager
  sessionManager: SessionManager
  adapter: EngineAdapter
}> {
  const taskManager = new TaskManager()
  const rpc = {
    tellActive: vi.fn(async () => []),
    tellWaiting: vi.fn(async () => []),
    tellStopped: vi.fn(async () => []),
  } as unknown as Aria2RpcClient
  const adapter = {
    createDownload: vi.fn(async () => 'unexpected-http-readd'),
    addTorrent: vi.fn(async () => 'unexpected-bt-readd'),
  } as unknown as EngineAdapter
  const sessionManager = new SessionManager(taskManager, rpc, db, adapter)
  await sessionManager.restore()
  return { taskManager, sessionManager, adapter }
}

function makeMutableRecoveryFs(existing: Set<string>): RecoveryFs {
  return {
    pathExists: vi.fn(async (absPath: string) => existing.has(absPath)),
    renameAtomic: vi.fn(async (src: string, dst: string) => {
      if (!existing.has(src)) throw new Error(`ENOENT: ${src}`)
      if (src !== dst && existing.has(dst)) throw new Error(`EEXIST: ${dst}`)
      existing.delete(src)
      existing.add(dst)
    }),
    removePathRecursive: vi.fn(async (absPath: string) => {
      existing.delete(absPath)
    }),
  }
}

function makeRecoveryLog(): RecoveryDeps['log'] {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

function makeFinalizeDeps(
  taskManager: TaskManager,
  persist: (task: DownloadTask) => Promise<void>
): FinalizeTaskDeps {
  return {
    taskManager: {
      getById: (id) => taskManager.getById(id),
      getAll: () => taskManager.getAll(),
      set: (id, task) => taskManager.set(id, task),
      setReservedEngineTaskOwner: (id, task, engineTaskId) =>
        taskManager.setReservedEngineTaskOwner(id, task, engineTaskId),
      reserveEngineTaskId: (engineTaskId) =>
        taskManager.reserveEngineTaskId(engineTaskId),
      releaseEngineTaskIdReservation: (engineTaskId) =>
        taskManager.releaseEngineTaskIdReservation(engineTaskId),
      retireEngineTaskIdReservation: (engineTaskId) =>
        taskManager.retireEngineTaskIdReservation(engineTaskId),
      persist,
    },
    adapter: {
      removeDownloadResult: vi.fn(async () => {}),
      forceRemoveTask: vi.fn(async () => {}),
      getUploadLength: vi.fn(async () => 0),
      getTaskStatus: vi.fn(async () => null),
      getTaskFiles: vi.fn(async () => []),
      addTorrent: vi.fn(async (params) => params.gid ?? 'gid-new'),
    },
    fs: {
      renameAtomic: vi.fn(async () => {}),
      removePathRecursive: vi.fn(async () => {}),
    },
    torrentMetaStore: {
      read: vi.fn(async () => new Uint8Array([1, 2, 3])),
    },
    settings: {
      get: () => ({ bt: { seedTime: 60, seedRatio: 1 } }),
    },
    eventBus: { emit: vi.fn() },
    publishTaskUpdate: vi.fn(),
    publishTaskUpdateNow: vi.fn(),
    activityRecorder: {
      recordSubmitted: vi.fn(),
      recordDownloadCompleted: vi.fn(),
    },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    createEngineTaskId: () => '0123456789abcdef',
  }
}

describe('lifecycle canonical persistence round trips', () => {
  it('restores the HTTP pre-rename intent persisted before a simulated crash', async () => {
    const task = makeSingleInstanceTask()
    const harness = makePersistenceHarness(task)
    const deps = makeFinalizeDeps(harness.taskManager, async (nextTask) => {
      await harness.persist(nextTask)
      throw new Error('simulated crash after durable intent')
    })

    await expect(finalizeTask(task.id, deps)).rejects.toThrow(
      'simulated crash after durable intent'
    )

    const row = harness.db.getTask(task.id)
    expect(row?.instances[0]).toMatchObject({
      gid: 'gid-old',
      transitionPhase: TransitionPhase.Renaming,
    })

    const restored = await restoreFromDatabase(harness.db, [
      makeRawStatus('gid-old', { status: 'complete' }),
    ])
    expect(restored.getById(task.id)).toMatchObject({
      engineTaskId: 'gid-old',
      transitionPhase: TransitionPhase.Renaming,
    })
  })

  it('persists BT Renaming, Reseeding, and adopted seeding identity snapshots', async () => {
    const task = makeSingleInstanceTask({ type: TaskType.Bt })
    const harness = makePersistenceHarness(task)
    const snapshots: Array<{
      phase: TransitionPhase
      gid: string | null
      status: TaskStatus
    }> = []
    const persist = async (nextTask: DownloadTask) => {
      await harness.persist(nextTask)
      const row = harness.db.getTask(task.id)
      const primary = row?.instances[0]
      if (!primary) throw new Error('primary instance was not persisted')
      snapshots.push({
        phase: primary.transitionPhase,
        gid: primary.gid,
        status: primary.status,
      })
    }
    const deps = makeFinalizeDeps(harness.taskManager, persist)

    await finalizeTask(task.id, deps)

    expect(snapshots).toContainEqual({
      phase: TransitionPhase.Renaming,
      gid: 'gid-old',
      status: TaskStatus.Finalizing,
    })
    expect(snapshots).toContainEqual({
      phase: TransitionPhase.Reseeding,
      gid: 'gid-old',
      status: TaskStatus.Finalizing,
    })
    expect(snapshots.at(-1)).toEqual({
      phase: TransitionPhase.Idle,
      gid: '0123456789abcdef',
      status: TaskStatus.Seeding,
    })
    expect(harness.taskManager.getByEngineTaskId('gid-old')).toBeUndefined()

    const restored = await restoreFromDatabase(harness.db, [
      makeRawStatus('0123456789abcdef', {
        status: 'active',
        seeder: 'true',
        infoHash: 'ABC123',
      }),
    ])
    expect(restored.getById(task.id)).toMatchObject({
      engineTaskId: '0123456789abcdef',
      transitionPhase: TransitionPhase.Idle,
    })
  })

  it('durably clears recovery intent and old gid when adopting an existing BT row', async () => {
    const task = makeSingleInstanceTask({
      type: TaskType.Bt,
      status: TaskStatus.Finalizing,
      diskPath: '/downloads/output',
      transitionPhase: TransitionPhase.Reseeding,
      instances: [
        makeInstance('lifecycle-task', TaskInstancePhase.BtDownload, {
          gid: 'gid-old',
          status: TaskStatus.Finalizing,
          diskPath: '/downloads/output',
          transitionPhase: TransitionPhase.Reseeding,
        }),
      ],
    })
    const harness = makePersistenceHarness(task)
    await harness.persist(task)
    const deps: RecoveryDeps = {
      taskManager: {
        getAll: () => harness.taskManager.getAll(),
        set: (id, nextTask) => harness.taskManager.set(id, nextTask),
        persist: harness.persist,
      },
      adapter: {
        listActiveAndWaiting: vi.fn(async () => [
          { gid: 'gid-new', infoHash: 'ABC123' },
        ]),
      },
      fs: {
        pathExists: vi.fn(async (path: string) => path === task.finalPath),
        renameAtomic: vi.fn(async () => {}),
        removePathRecursive: vi.fn(async () => {}),
      },
      activityRecorder: {
        recordSubmitted: vi.fn(),
        recordDownloadCompleted: vi.fn(),
      },
      finalizeTask: vi.fn(async () => {}),
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    }

    await new TaskRecoveryServiceImpl(deps).recoverOnStartup()

    expect(harness.db.getTask(task.id)?.instances[0]).toMatchObject({
      gid: 'gid-new',
      status: TaskStatus.Seeding,
      transitionPhase: TransitionPhase.Idle,
      diskPath: '/downloads/output',
    })
    expect(harness.taskManager.getByEngineTaskId('gid-old')).toBeUndefined()
    expect(harness.taskManager.getByEngineTaskId('gid-new')).toMatchObject({
      id: task.id,
      status: TaskStatus.Seeding,
    })

    const restored = await restoreFromDatabase(harness.db, [
      makeRawStatus('gid-new', {
        status: 'active',
        seeder: 'true',
        infoHash: 'ABC123',
      }),
    ])
    expect(restored.getById(task.id)).toMatchObject({
      engineTaskId: 'gid-new',
      transitionPhase: TransitionPhase.Idle,
    })
  })
})

describe('real restore → startup recovery ordering', () => {
  it('HTTP temp_only bypasses re-add and completes the persisted rename', async () => {
    const task = makeSingleInstanceTask({
      id: 'restore-http-temp',
      status: TaskStatus.Finalizing,
      transitionPhase: TransitionPhase.Renaming,
      instances: [
        makeInstance('restore-http-temp', TaskInstancePhase.HttpDownload, {
          gid: 'retired-http',
          status: TaskStatus.Finalizing,
          transitionPhase: TransitionPhase.Renaming,
          diskPath: '/downloads/http.motrix',
        }),
      ],
      engineTaskId: 'retired-http',
      diskPath: '/downloads/http.motrix',
      finalPath: '/downloads/http',
    })
    const harness = makePersistenceHarness(task)
    await harness.persist(task)
    const restored = await restoreRuntimeFromDatabase(harness.db)
    const restoredTask = restored.taskManager.getById(task.id)
    expect(restoredTask?.transitionPhase).toBe(TransitionPhase.Renaming)
    expect(restored.adapter.createDownload).not.toHaveBeenCalled()

    const existing = new Set(['/downloads/http.motrix'])
    const recoveryFs = makeMutableRecoveryFs(existing)
    const persistForRecovery = (nextTask: DownloadTask) =>
      restored.sessionManager.persistTask(nextTask)
    const finalizeDeps = makeFinalizeDeps(restored.taskManager, (nextTask) =>
      restored.sessionManager.persistTask(nextTask)
    )
    finalizeDeps.fs = recoveryFs
    const recovery = new TaskRecoveryServiceImpl({
      taskManager: {
        getAll: () => restored.taskManager.getAll(),
        set: (id, nextTask) => restored.taskManager.set(id, nextTask),
        persist: persistForRecovery,
      },
      adapter: { listActiveAndWaiting: vi.fn(async () => []) },
      fs: recoveryFs,
      activityRecorder: finalizeDeps.activityRecorder,
      finalizeTask: (taskId) => finalizeTask(taskId, finalizeDeps),
      log: makeRecoveryLog(),
    })

    await recovery.recoverOnStartup()

    expect(existing).toEqual(new Set(['/downloads/http']))
    expect(restored.taskManager.getById(task.id)).toMatchObject({
      status: TaskStatus.Completed,
      transitionPhase: TransitionPhase.Idle,
      diskPath: '/downloads/http',
    })
  })

  it('BT final_only bypasses restore re-add and resumes reseeding', async () => {
    const task = makeSingleInstanceTask({
      id: 'restore-bt-final',
      type: TaskType.Bt,
      status: TaskStatus.Finalizing,
      transitionPhase: TransitionPhase.Reseeding,
      diskPath: '/downloads/bt',
      finalPath: '/downloads/bt',
      instances: [
        makeInstance('restore-bt-final', TaskInstancePhase.BtDownload, {
          gid: 'retired-bt',
          status: TaskStatus.Finalizing,
          transitionPhase: TransitionPhase.Reseeding,
          diskPath: '/downloads/bt',
        }),
      ],
      engineTaskId: 'retired-bt',
      infoHash: 'BT-RESTORE-HASH',
      torrentMetaPath: '/state/restore-bt-final.torrent',
    })
    const harness = makePersistenceHarness(task)
    await harness.persist(task)
    const restored = await restoreRuntimeFromDatabase(harness.db)
    expect(restored.adapter.addTorrent).not.toHaveBeenCalled()

    const recoveryFs = makeMutableRecoveryFs(new Set(['/downloads/bt']))
    const persist = (nextTask: DownloadTask) =>
      restored.sessionManager.persistTask(nextTask)
    const finalizeDeps = makeFinalizeDeps(restored.taskManager, persist)
    const recovery = new TaskRecoveryServiceImpl({
      taskManager: {
        getAll: () => restored.taskManager.getAll(),
        set: (id, nextTask) => restored.taskManager.set(id, nextTask),
        persist,
      },
      adapter: { listActiveAndWaiting: vi.fn(async () => []) },
      fs: recoveryFs,
      activityRecorder: finalizeDeps.activityRecorder,
      finalizeTask: (taskId) => finalizeTask(taskId, finalizeDeps),
      log: makeRecoveryLog(),
    })

    const report = await recovery.recoverOnStartup()

    expect(report.errors).toEqual([])
    expect(finalizeDeps.adapter.addTorrent).toHaveBeenCalledOnce()
    expect(restored.taskManager.getById(task.id)).toMatchObject({
      status: TaskStatus.Seeding,
      transitionPhase: TransitionPhase.Idle,
      engineTaskId: expect.stringMatching(/^[0-9a-f]{16}$/),
      diskPath: '/downloads/bt',
    })
  })

  it('media temp_only remains recoverable through restore and completes without aria2 re-add', async () => {
    const task = makeSingleInstanceTask({
      id: 'restore-media-temp',
      kind: TaskKind.Mux,
      type: TaskType.Http,
      status: TaskStatus.Finalizing,
      transitionPhase: TransitionPhase.Renaming,
      engineTaskId: '',
      diskPath: '/downloads/media.mp4.motrix',
      finalPath: '/downloads/media.mp4',
      instances: [
        makeInstance('restore-media-temp', TaskInstancePhase.FfmpegMux, {
          gid: null,
          status: TaskStatus.Finalizing,
          transitionPhase: TransitionPhase.Renaming,
          diskPath: '/downloads/media.mp4.motrix',
          uris: [],
        }),
      ],
    })
    const harness = makePersistenceHarness(task)
    await harness.persist(task)
    const restored = await restoreRuntimeFromDatabase(harness.db)
    expect(restored.adapter.createDownload).not.toHaveBeenCalled()
    expect(restored.taskManager.getById(task.id)?.status).toBe(
      TaskStatus.Finalizing
    )

    const existing = new Set(['/downloads/media.mp4.motrix'])
    const recoveryFs = makeMutableRecoveryFs(existing)
    const persist = async (nextTask: DownloadTask) => {
      restored.taskManager.set(nextTask.id, nextTask)
      await restored.sessionManager.save()
    }
    const recovery = new TaskRecoveryServiceImpl({
      taskManager: {
        getAll: () => restored.taskManager.getAll(),
        persist,
      },
      adapter: { listActiveAndWaiting: vi.fn(async () => []) },
      fs: recoveryFs,
      activityRecorder: {
        recordSubmitted: vi.fn(),
        recordDownloadCompleted: vi.fn(),
      },
      finalizeTask: vi.fn(async () => {}),
      log: makeRecoveryLog(),
    })

    await recovery.recoverOnStartup()

    expect(existing).toEqual(new Set(['/downloads/media.mp4']))
    expect(restored.taskManager.getById(task.id)).toMatchObject({
      status: TaskStatus.Completed,
      transitionPhase: TransitionPhase.Idle,
      diskPath: '/downloads/media.mp4',
    })
  })

  it.each([
    ['HTTP', TaskKind.Direct, TaskType.Http],
    ['BT', TaskKind.Bt, TaskType.Bt],
    ['media', TaskKind.Mux, TaskType.Http],
  ])(
    '%s both-path conflict stays quarantined across polling and a second restart',
    async (_label, kind, type) => {
      const task = makeSingleInstanceTask({
        id: `restore-both-${kind}`,
        kind,
        type,
        status: TaskStatus.Error,
        errorMessage: 'old rename failure',
        transitionPhase: TransitionPhase.Renaming,
        diskPath: `/downloads/${kind}.motrix`,
        finalPath: `/downloads/${kind}`,
        instances: [
          makeInstance(
            `restore-both-${kind}`,
            kind === TaskKind.Mux
              ? TaskInstancePhase.FfmpegMux
              : type === TaskType.Bt
                ? TaskInstancePhase.BtDownload
                : TaskInstancePhase.HttpDownload,
            {
              gid: kind === TaskKind.Mux ? null : `live-${kind}`,
              status: TaskStatus.Error,
              transitionPhase: TransitionPhase.Renaming,
              diskPath: `/downloads/${kind}.motrix`,
              uris:
                kind === TaskKind.Mux ? [] : [`https://example.com/${kind}`],
            }
          ),
        ],
        engineTaskId: kind === TaskKind.Mux ? '' : `live-${kind}`,
        infoHash: type === TaskType.Bt ? `hash-${kind}` : null,
      })
      const harness = makePersistenceHarness(task)
      await harness.persist(task)
      const restored = await restoreRuntimeFromDatabase(harness.db)
      const existing = new Set([
        `/downloads/${kind}.motrix`,
        `/downloads/${kind}`,
      ])
      const recoveryFs = makeMutableRecoveryFs(existing)
      const persist = async (nextTask: DownloadTask) => {
        restored.taskManager.set(nextTask.id, nextTask)
        await restored.sessionManager.save()
      }
      const recoveryDeps: RecoveryDeps = {
        taskManager: {
          getAll: () => restored.taskManager.getAll(),
          persist,
        },
        adapter: {
          listActiveAndWaiting: vi.fn(async () =>
            kind === TaskKind.Mux
              ? []
              : [
                  {
                    gid: `live-${kind}`,
                    infoHash: type === TaskType.Bt ? `hash-${kind}` : undefined,
                  },
                ]
          ),
        },
        fs: recoveryFs,
        activityRecorder: {
          recordSubmitted: vi.fn(),
          recordDownloadCompleted: vi.fn(),
        },
        finalizeTask: vi.fn(async () => {}),
        log: makeRecoveryLog(),
        db: harness.db,
        occurrenceDispatcher: { dispatch: vi.fn(async () => {}) },
      }

      await new TaskRecoveryServiceImpl(recoveryDeps).recoverOnStartup()
      const quarantined = restored.taskManager.getById(task.id)
      expect(quarantined).toMatchObject({
        status: TaskStatus.Error,
        transitionPhase: TransitionPhase.Renaming,
        errorDetailKey: 'task.error.detail.recoveryOutputConflict',
        errorMessage: null,
      })

      if (quarantined && kind !== TaskKind.Mux) {
        const engineSnapshot = makeSingleInstanceTask({
          id: 'engine-row',
          engineTaskId: `live-${kind}`,
          type,
          kind,
          status:
            type === TaskType.Bt ? TaskStatus.Seeding : TaskStatus.Completed,
        })
        const merged = mergeEngineTask(quarantined, engineSnapshot)
        restored.taskManager.set(merged.id, merged)
        await restored.sessionManager.save()
        expect(merged.status).toBe(TaskStatus.Error)
        expect(merged.transitionPhase).toBe(TransitionPhase.Renaming)
      }

      const restarted = await restoreRuntimeFromDatabase(harness.db)
      const restartedTask = restarted.taskManager.getById(task.id)
      expect(restartedTask).toMatchObject({
        status: TaskStatus.Error,
        transitionPhase: TransitionPhase.Renaming,
        errorDetailKey: 'task.error.detail.recoveryOutputConflict',
        errorMessage: null,
      })
      const secondPersist = async (nextTask: DownloadTask) => {
        restarted.taskManager.set(nextTask.id, nextTask)
        await restarted.sessionManager.save()
      }
      await new TaskRecoveryServiceImpl({
        ...recoveryDeps,
        taskManager: {
          getAll: () => restarted.taskManager.getAll(),
          persist: secondPersist,
        },
      }).recoverOnStartup()
      expect(restarted.taskManager.getById(task.id)).toMatchObject({
        status: TaskStatus.Error,
        transitionPhase: TransitionPhase.Renaming,
        errorDetailKey: 'task.error.detail.recoveryOutputConflict',
        errorMessage: null,
      })
      expect(existing).toEqual(
        new Set([`/downloads/${kind}.motrix`, `/downloads/${kind}`])
      )
    }
  )
})
