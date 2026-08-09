import { ErrorCode } from '@shared/errors'
import { Events } from '@shared/protocol/events'
import {
  TaskInstancePhase,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { directTaskUpdatePublication } from '@test-utils/task-update'
import { describe, expect, it, vi } from 'vitest'
import type { EngineAdapter } from '../../engine/engine-adapter'
import type { EventBus } from '../../events/event-bus'
import type { Logger } from '../../logger'
import type { MagnetTracker } from '../../torrent/magnet-tracker'
import type { FileCleanupService } from '../file-cleanup-service'
import type { TaskManager } from '../task-manager'
import type { TorrentMetaStore } from '../torrent-meta-store'
import { type RemoveTaskDeps, removeTask } from './remove-task'

function makeDeps(overrides: Partial<RemoveTaskDeps> = {}): RemoveTaskDeps {
  const base = {
    taskManager: {
      getById: vi.fn(),
      getAll: vi.fn(() => []),
      remove: vi.fn(),
    } as unknown as TaskManager,
    adapter: {
      removeTask: vi.fn().mockResolvedValue(undefined),
      forceRemoveTask: vi.fn().mockResolvedValue(undefined),
      removeDownloadResult: vi.fn().mockResolvedValue(undefined),
    } as unknown as EngineAdapter,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
    fileCleanupService: {
      cleanup: vi.fn(async () => {}),
    } as FileCleanupService,
    torrentMetaStore: {
      persist: vi.fn(),
      read: vi.fn(),
      remove: vi.fn(async () => {}),
    } as unknown as TorrentMetaStore,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    db: {
      deleteTask: vi.fn(),
      getTask: vi.fn().mockReturnValue(null),
      saveTaskWithInstances: vi.fn(),
    },
    magnetTracker: {
      cancel: vi.fn().mockResolvedValue('removed'),
      markPendingUserDelete: vi.fn(),
    } as unknown as MagnetTracker,
    runTaskMutation: async <T>(
      _taskIds: readonly string[],
      operation: () => Promise<T>
    ): Promise<T> => operation(),
    taskPersistence: {
      runExclusivePersistence: vi.fn(
        async (operation: () => unknown | Promise<unknown>) => operation()
      ) as unknown as RemoveTaskDeps['taskPersistence']['runExclusivePersistence'],
    },
    deleteParentTasks: vi.fn(
      async (
        _taskIds: readonly string[],
        deleteParents: () => void | Promise<void>
      ) => deleteParents()
    ),
  }
  return { ...base, ...directTaskUpdatePublication(base), ...overrides }
}

describe('removeTask', () => {
  it('tears down the coordinator for a media task and never calls the engine with an empty gid', async () => {
    // A coordinator-managed media task (Mux/Hls) has engineTaskId ''. Removing
    // it must abort the in-flight SegmentDownloaders + ffmpeg (via cancelMedia)
    // or they orphan; and it must never call adapter.removeTask('').
    const cancelMedia = vi.fn(async () => {})
    const deps = makeDeps({ cancelMedia })
    const task = {
      id: 'm1',
      engineTaskId: '',
      diskPath: '/d/video.mp4',
      saveDir: '/d',
      type: TaskType.Http,
      status: TaskStatus.Downloading,
      torrentMetaPath: null,
      instances: [],
    }
    vi.mocked(deps.taskManager.getById).mockReturnValue(
      task as unknown as ReturnType<TaskManager['getById']>
    )

    await removeTask('m1', { deleteWithFiles: false }, deps)

    expect(cancelMedia).toHaveBeenCalledWith('m1')
    expect(deps.adapter.removeTask).not.toHaveBeenCalled()
    expect(deps.taskManager.remove).toHaveBeenCalledWith('m1')
  })

  it('purges a terminal engine result before removing from TaskManager', async () => {
    const deps = makeDeps()
    const task = {
      id: 't1',
      engineTaskId: 'gid-1',
      diskPath: '/d/foo.mp4',
      type: TaskType.Http,
      status: TaskStatus.Completed,
      torrentMetaPath: null,
    }
    vi.mocked(deps.taskManager.getById).mockReturnValue(
      task as unknown as ReturnType<TaskManager['getById']>
    )

    await removeTask('t1', { deleteWithFiles: false }, deps)

    expect(deps.adapter.forceRemoveTask).not.toHaveBeenCalled()
    expect(deps.adapter.removeDownloadResult).toHaveBeenCalledWith('gid-1')
    expect(deps.adapter.removeTask).not.toHaveBeenCalled()
    expect(deps.taskManager.remove).toHaveBeenCalledWith('t1')
    // Regression: without the db delete, SessionManager.restore would
    // resurrect this row on next app start (Pass 2 adopts every
    // unconsumed Completed row).
    expect(deps.db.deleteTask).toHaveBeenCalledWith('t1')
  })

  it('force-removes an active gid and then purges its stopped result', async () => {
    const order: string[] = []
    const deps = makeDeps({
      adapter: {
        forceRemoveTask: vi.fn(async () => {
          order.push('force-remove')
        }),
        removeDownloadResult: vi.fn(async () => {
          order.push('purge-result')
        }),
      } as unknown as EngineAdapter,
      db: {
        deleteTask: vi.fn(() => order.push('delete-parent')),
        getTask: vi.fn().mockReturnValue(null),
        saveTaskWithInstances: vi.fn(),
      },
    })
    vi.mocked(deps.taskManager.getById).mockReturnValue({
      id: 'active',
      engineTaskId: 'gid-active',
      diskPath: '/d/file.motrix',
      type: TaskType.Http,
      status: TaskStatus.Downloading,
      torrentMetaPath: null,
      instances: [],
    } as unknown as ReturnType<TaskManager['getById']>)

    await removeTask('active', { deleteWithFiles: false }, deps)

    expect(order).toEqual(['force-remove', 'purge-result', 'delete-parent'])
  })

  it('retains the parent and files when neither engine cleanup call can confirm absence', async () => {
    const forceError = new Error('force-remove transport disconnected')
    const resultError = new Error('result-cleanup transport disconnected')
    const deps = makeDeps({
      adapter: {
        forceRemoveTask: vi.fn().mockRejectedValue(forceError),
        removeDownloadResult: vi.fn().mockRejectedValue(resultError),
      } as unknown as EngineAdapter,
    })
    vi.mocked(deps.taskManager.getById).mockReturnValue({
      id: 'active',
      engineTaskId: 'gid-active',
      diskPath: '/d/file.motrix',
      type: TaskType.Http,
      status: TaskStatus.Downloading,
      torrentMetaPath: null,
      instances: [],
    } as unknown as ReturnType<TaskManager['getById']>)

    await expect(
      removeTask('active', { deleteWithFiles: true }, deps)
    ).rejects.toBe(resultError)

    expect(deps.adapter.removeDownloadResult).toHaveBeenCalledWith('gid-active')
    expect(deps.fileCleanupService.cleanup).not.toHaveBeenCalled()
    expect(deps.db.deleteTask).not.toHaveBeenCalled()
    expect(deps.taskManager.remove).not.toHaveBeenCalled()
  })

  it('continues when force-remove fails but result cleanup confirms the gid is absent', async () => {
    const forceError = new Error('gid already stopped')
    const deps = makeDeps({
      adapter: {
        forceRemoveTask: vi.fn().mockRejectedValue(forceError),
        removeDownloadResult: vi.fn().mockResolvedValue(undefined),
      } as unknown as EngineAdapter,
    })
    vi.mocked(deps.taskManager.getById).mockReturnValue({
      id: 'active',
      engineTaskId: 'gid-active',
      diskPath: '/d/file.motrix',
      type: TaskType.Http,
      status: TaskStatus.Downloading,
      torrentMetaPath: null,
      instances: [],
    } as unknown as ReturnType<TaskManager['getById']>)

    await removeTask('active', { deleteWithFiles: false }, deps)

    expect(deps.db.deleteTask).toHaveBeenCalledWith('active')
    expect(deps.taskManager.remove).toHaveBeenCalledWith('active')
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: forceError }),
      expect.stringContaining('confirmed absence')
    )
  })

  it('retains the parent when stopped-result cleanup fails after force-remove', async () => {
    const transportError = new Error('rpc transport disconnected')
    const deps = makeDeps({
      adapter: {
        forceRemoveTask: vi.fn().mockResolvedValue(undefined),
        removeDownloadResult: vi.fn().mockRejectedValue(transportError),
      } as unknown as EngineAdapter,
    })
    vi.mocked(deps.taskManager.getById).mockReturnValue({
      id: 'active',
      engineTaskId: 'gid-active',
      diskPath: '/d/file.motrix',
      type: TaskType.Http,
      status: TaskStatus.Paused,
      torrentMetaPath: null,
      instances: [],
    } as unknown as ReturnType<TaskManager['getById']>)

    await expect(
      removeTask('active', { deleteWithFiles: true }, deps)
    ).rejects.toBe(transportError)

    expect(deps.fileCleanupService.cleanup).not.toHaveBeenCalled()
    expect(deps.db.deleteTask).not.toHaveBeenCalled()
    expect(deps.taskManager.remove).not.toHaveBeenCalled()
  })

  it('crosses the activity tombstone barrier before deleting the parent row', async () => {
    const order: string[] = []
    const deps = makeDeps({
      deleteParentTasks: vi.fn(async (taskIds, deleteParents) => {
        order.push(`tombstone:${taskIds.join(',')}`)
        await deleteParents()
      }),
      db: {
        deleteTask: vi.fn(() => order.push('parent-delete')),
        getTask: vi.fn().mockReturnValue(null),
        saveTaskWithInstances: vi.fn(),
      },
    })
    vi.mocked(deps.taskManager.getById).mockReturnValue({
      id: 't1',
      engineTaskId: 'gid-1',
      diskPath: '/d/foo.mp4',
      type: TaskType.Http,
      status: TaskStatus.Completed,
      torrentMetaPath: null,
      instances: [],
    } as unknown as ReturnType<TaskManager['getById']>)

    await removeTask('t1', { deleteWithFiles: false }, deps)

    expect(order).toEqual(['tombstone:t1', 'parent-delete'])
    expect(deps.deleteParentTasks).toHaveBeenCalledOnce()
  })

  it('serializes the activity delete barrier and parent deletion in the persistence queue', async () => {
    const order: string[] = []
    const deps = makeDeps({
      taskPersistence: {
        runExclusivePersistence: async <T>(
          operation: () => T | Promise<T>
        ): Promise<T> => {
          order.push('persistence-enter')
          const result = await operation()
          order.push('persistence-exit')
          return result
        },
      },
      deleteParentTasks: vi.fn(async (_taskIds, deleteParents) => {
        order.push('activity-tombstone')
        await deleteParents()
      }),
      db: {
        deleteTask: vi.fn(() => order.push('parent-delete')),
        getTask: vi.fn().mockReturnValue(null),
        saveTaskWithInstances: vi.fn(),
      },
    })
    vi.mocked(deps.taskManager.getById).mockReturnValue({
      id: 't1',
      engineTaskId: 'gid-1',
      diskPath: '/d/foo.mp4',
      type: TaskType.Http,
      status: TaskStatus.Completed,
      torrentMetaPath: null,
      instances: [],
    } as unknown as ReturnType<TaskManager['getById']>)

    await removeTask('t1', { deleteWithFiles: false }, deps)

    expect(order).toEqual([
      'persistence-enter',
      'activity-tombstone',
      'parent-delete',
      'persistence-exit',
    ])
  })

  it('does not publish removal when the durable parent delete fails', async () => {
    const deps = makeDeps({
      deleteParentTasks: vi.fn(async (_taskIds, deleteParents) => {
        await deleteParents()
      }),
      db: {
        deleteTask: vi.fn(() => {
          throw new Error('disk full')
        }),
        getTask: vi.fn().mockReturnValue(null),
        saveTaskWithInstances: vi.fn(),
      },
    })
    vi.mocked(deps.taskManager.getById).mockReturnValue({
      id: 't1',
      engineTaskId: 'gid-1',
      diskPath: '/d/foo.mp4',
      type: TaskType.Http,
      status: TaskStatus.Completed,
      torrentMetaPath: null,
      instances: [],
    } as unknown as ReturnType<TaskManager['getById']>)

    await expect(
      removeTask('t1', { deleteWithFiles: false }, deps)
    ).rejects.toThrow('disk full')

    expect(deps.taskManager.remove).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).toHaveBeenCalledTimes(1)
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      Events.ToastShow,
      expect.any(Object)
    )
  })

  it('routes the removal broadcast through the coalescing publisher', async () => {
    const publishTaskUpdate = vi.fn()
    const publishTaskUpdateNow = vi.fn()
    const deps = makeDeps({ publishTaskUpdate, publishTaskUpdateNow })
    vi.mocked(deps.taskManager.getById).mockReturnValue({
      id: 't1',
      engineTaskId: 'gid-1',
      diskPath: '/d/foo.mp4',
      type: TaskType.Http,
      status: TaskStatus.Completed,
      torrentMetaPath: null,
      instances: [],
    } as unknown as ReturnType<TaskManager['getById']>)

    await removeTask('t1', { deleteWithFiles: false }, deps)

    expect(publishTaskUpdate).toHaveBeenCalledTimes(1)
    expect(publishTaskUpdateNow).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).not.toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.anything()
    )
  })

  it('does NOT touch db.deleteTask when task is missing', async () => {
    const deps = makeDeps()
    vi.mocked(deps.taskManager.getById).mockReturnValue(undefined)

    await removeTask('missing', { deleteWithFiles: true }, deps)

    expect(deps.db.deleteTask).not.toHaveBeenCalled()
  })

  it('does NOT touch db.deleteTask when remove is rejected during finalize', async () => {
    const deps = makeDeps()
    vi.mocked(deps.taskManager.getById).mockReturnValue({
      id: 'fz',
      engineTaskId: 'gz',
      diskPath: '/d/x.motrix',
      type: TaskType.Bt,
      status: TaskStatus.Finalizing,
      torrentMetaPath: null,
    } as unknown as ReturnType<TaskManager['getById']>)

    await expect(
      removeTask('fz', { deleteWithFiles: false }, deps)
    ).rejects.toMatchObject({
      code: ErrorCode.TaskRemoveNotAvailableDuringFinalize,
    })
    expect(deps.db.deleteTask).not.toHaveBeenCalled()
  })

  it('warns and short-circuits when task is not found', async () => {
    const deps = makeDeps()
    vi.mocked(deps.taskManager.getById).mockReturnValue(undefined)

    await removeTask('missing', { deleteWithFiles: true }, deps)

    expect(deps.adapter.removeTask).not.toHaveBeenCalled()
    expect(deps.taskManager.remove).not.toHaveBeenCalled()
    expect(deps.log.warn).toHaveBeenCalled()
  })
})

describe('removeTask with deleteWithFiles', () => {
  it('deleteWithFiles=true HTTP: calls cleanup on diskPath, skips torrent meta', async () => {
    const deps = makeDeps()
    const task = {
      id: 't1',
      engineTaskId: 'g1',
      diskPath: '/d/foo.mp4.motrix',
      type: TaskType.Http,
      status: TaskStatus.Paused,
      torrentMetaPath: null,
    }
    vi.mocked(deps.taskManager.getById).mockReturnValue(
      task as unknown as ReturnType<TaskManager['getById']>
    )

    await removeTask('t1', { deleteWithFiles: true }, deps)

    expect(deps.fileCleanupService.cleanup).toHaveBeenCalledWith(
      '/d/foo.mp4.motrix',
      TaskType.Http
    )
    expect(deps.torrentMetaStore.remove).not.toHaveBeenCalled()
    expect(deps.taskManager.remove).toHaveBeenCalledWith('t1')
  })

  it('deleteWithFiles=true BT: removes container and torrent metadata', async () => {
    const deps = makeDeps()
    const task = {
      id: 't2',
      engineTaskId: 'g2',
      diskPath: '/d/tor.motrix',
      type: TaskType.Bt,
      status: TaskStatus.Paused,
      torrentMetaPath: '/u/torrents/t2.torrent',
    }
    vi.mocked(deps.taskManager.getById).mockReturnValue(
      task as unknown as ReturnType<TaskManager['getById']>
    )

    await removeTask('t2', { deleteWithFiles: true }, deps)

    expect(deps.fileCleanupService.cleanup).toHaveBeenCalledWith(
      '/d/tor.motrix',
      TaskType.Bt
    )
    expect(deps.torrentMetaStore.remove).toHaveBeenCalledWith(
      '/u/torrents/t2.torrent'
    )
  })

  it('deleteWithFiles=true metadata-only magnet: skips file cleanup', async () => {
    const deps = makeDeps()
    const task = {
      id: 'meta-1',
      engineTaskId: 'gid-meta',
      diskPath: '/',
      type: TaskType.Magnet,
      status: TaskStatus.FetchingMetadata,
      torrentMetaPath: null,
    }
    vi.mocked(deps.taskManager.getById).mockReturnValue(
      task as unknown as ReturnType<TaskManager['getById']>
    )

    await removeTask('meta-1', { deleteWithFiles: true }, deps)

    expect(deps.fileCleanupService.cleanup).not.toHaveBeenCalled()
    expect(deps.torrentMetaStore.remove).not.toHaveBeenCalled()
    expect(deps.taskManager.remove).toHaveBeenCalledWith('meta-1')
    expect(deps.db.deleteTask).toHaveBeenCalledWith('meta-1')
  })

  it('deleteWithFiles=true: refuses cleanup when diskPath equals the save root (poisoned swap row)', async () => {
    // Regression for the rmdir-~/Downloads data-loss bug: a magnet resolved
    // via the (pre-fix) swap path persisted diskPath == saveDir == the bare
    // save root. Deleting "with files" must NEVER recursively remove the
    // user's configured download directory. The task is still removed from
    // the model + DB; only the destructive file cleanup is skipped.
    const deps = makeDeps()
    const task = {
      id: 'poison',
      engineTaskId: 'gp',
      diskPath: '/Downloads',
      saveDir: '/Downloads',
      type: TaskType.Bt,
      status: TaskStatus.Paused,
      torrentMetaPath: null,
    }
    vi.mocked(deps.taskManager.getById).mockReturnValue(
      task as unknown as ReturnType<TaskManager['getById']>
    )

    await removeTask('poison', { deleteWithFiles: true }, deps)

    expect(deps.fileCleanupService.cleanup).not.toHaveBeenCalled()
    expect(deps.taskManager.remove).toHaveBeenCalledWith('poison')
    expect(deps.db.deleteTask).toHaveBeenCalledWith('poison')
  })

  it('deleteWithFiles=true with root diskPath: skips file cleanup', async () => {
    const deps = makeDeps()
    const task = {
      id: 'root-path',
      engineTaskId: 'gid-root',
      diskPath: '/',
      type: TaskType.Magnet,
      status: TaskStatus.Queued,
      torrentMetaPath: null,
    }
    vi.mocked(deps.taskManager.getById).mockReturnValue(
      task as unknown as ReturnType<TaskManager['getById']>
    )

    await removeTask('root-path', { deleteWithFiles: true }, deps)

    expect(deps.fileCleanupService.cleanup).not.toHaveBeenCalled()
    expect(deps.taskManager.remove).toHaveBeenCalledWith('root-path')
    expect(deps.db.deleteTask).toHaveBeenCalledWith('root-path')
  })

  it('deleteWithFiles=false: skips cleanup and emits orphan toast', async () => {
    const deps = makeDeps()
    const task = {
      id: 't3',
      engineTaskId: 'g3',
      diskPath: '/d/foo.mp4.motrix',
      type: TaskType.Http,
      status: TaskStatus.Downloading,
      torrentMetaPath: null,
    }
    vi.mocked(deps.taskManager.getById).mockReturnValue(
      task as unknown as ReturnType<TaskManager['getById']>
    )

    await removeTask('t3', { deleteWithFiles: false }, deps)

    expect(deps.fileCleanupService.cleanup).not.toHaveBeenCalled()
    expect(deps.torrentMetaStore.remove).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      Events.ToastShow,
      expect.objectContaining({
        key: 'task.remove.orphanToast',
        params: { path: '/d/foo.mp4.motrix' },
      })
    )
    expect(deps.taskManager.remove).toHaveBeenCalledWith('t3')
  })

  it('rejects when task is in Finalizing state', async () => {
    const deps = makeDeps()
    vi.mocked(deps.taskManager.getById).mockReturnValue({
      id: 't4',
      engineTaskId: 'g4',
      diskPath: '/d/x.motrix',
      type: TaskType.Bt,
      status: TaskStatus.Finalizing,
      torrentMetaPath: null,
    } as unknown as ReturnType<TaskManager['getById']>)

    await expect(
      removeTask('t4', { deleteWithFiles: true }, deps)
    ).rejects.toMatchObject({
      code: ErrorCode.TaskRemoveNotAvailableDuringFinalize,
    })
    expect(deps.adapter.removeTask).not.toHaveBeenCalled()
    expect(deps.fileCleanupService.cleanup).not.toHaveBeenCalled()
    expect(deps.taskManager.remove).not.toHaveBeenCalled()
  })
})

describe('removeTask with magnet_metadata_resolution primary instance', () => {
  function makeMagnetMetadataTask(
    motrixId: string,
    gid: string,
    phaseStatus: TaskStatus = TaskStatus.FetchingMetadata
  ) {
    return {
      id: motrixId,
      engineTaskId: gid,
      diskPath: '/tmp/motrix-magnet-metadata-x',
      type: TaskType.Magnet,
      status: phaseStatus,
      torrentMetaPath: null,
      instances: [
        {
          instanceId: `meta:${motrixId}`,
          motrixId,
          gid,
          phase: TaskInstancePhase.MagnetMetadataResolution,
          status: phaseStatus,
          progress: 0,
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
        },
      ],
    }
  }

  it('cancels the magnet metadata fetch and deletes DB row on clean removal', async () => {
    const deps = makeDeps()
    vi.mocked(deps.taskManager.getById).mockReturnValue(
      makeMagnetMetadataTask('m-pending', 'g-meta') as unknown as ReturnType<
        TaskManager['getById']
      >
    )

    await removeTask('m-pending', { deleteWithFiles: false }, deps)

    expect(deps.magnetTracker.cancel).toHaveBeenCalledWith('m-pending', {
      deleteTaskRow: false,
    })
    expect(deps.taskManager.remove).toHaveBeenCalledWith('m-pending')
    expect(deps.db.deleteTask).toHaveBeenCalledWith('m-pending')
  })

  it('preserves DB tombstone when cleanup is quarantined (Codex finding #9)', async () => {
    const deps = makeDeps()
    vi.mocked(deps.magnetTracker.cancel).mockResolvedValue('quarantined')
    vi.mocked(deps.taskManager.getById).mockReturnValue(
      makeMagnetMetadataTask('m-q', 'g-meta') as unknown as ReturnType<
        TaskManager['getById']
      >
    )
    // Seed db.getTask so removeTask can stamp aggStatus=Error.
    vi.mocked(deps.db.getTask).mockReturnValue({
      task: {
        motrixId: 'm-q',
        name: '[METADATA] xyz',
        kind: 'bt',
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
        aggStatus: TaskStatus.FetchingMetadata,
        uploadedBytesBaseline: 0,
        source: 'user',
        sourceMeta: null,
      },
      instances: [
        {
          instanceId: 'meta:m-q',
          motrixId: 'm-q',
          gid: 'g-meta',
          phase: TaskInstancePhase.MagnetMetadataResolution,
          status: TaskStatus.FetchingMetadata,
          progress: 0,
          totalBytes: 0,
          downloadedBytes: 0,
          uploadedBytes: 0,
          diskPath: '/tmp',
          transitionPhase: TransitionPhase.Idle,
          uris: ['magnet:?xt=urn:btih:abc'],
          uriHash: null,
          payload: { metadataDir: '/tmp' },
          createdAt: 1700000000,
          updatedAt: 1700000001,
        },
      ],
    } as never)

    await removeTask('m-q', { deleteWithFiles: false }, deps)

    expect(deps.magnetTracker.cancel).toHaveBeenCalledWith('m-q', {
      deleteTaskRow: false,
    })
    // DB row retained — primeFromDatabase will rebuild the polling
    // shield from this row on restart.
    expect(deps.db.deleteTask).not.toHaveBeenCalled()
    // Codex finding #13: removeTask explicitly stamps aggStatus=Error
    // so SessionManager.restore (which skips Error magnet rows) does
    // not resurrect the just-removed task. cancel() returns
    // 'quarantined' on the first transient failure (attempts=1) long
    // before MAX_CLEANUP_ATTEMPTS' give-up branch sets Error itself.
    const saved = vi.mocked(deps.db.saveTaskWithInstances).mock.calls[0][0] as {
      task: {
        aggStatus: TaskStatus
        errorMessage: string | null
        errorDetailKey: string | null
      }
      instances: { status: TaskStatus }[]
    }
    expect(saved.task.aggStatus).toBe(TaskStatus.Error)
    expect(saved.task.errorDetailKey).toBe(
      'task.error.detail.magnetCleanupQuarantined'
    )
    expect(saved.task.errorMessage).toBeNull()
    expect(saved.instances[0].status).toBe(TaskStatus.Error)
    expect(
      (saved.instances[0] as { payload?: Record<string, unknown> }).payload
        ?.cleanupQuarantined
    ).toBe(true)
    expect(
      (saved.instances[0] as { payload?: Record<string, unknown> }).payload
        ?.cleanupTombstoneHidden
    ).toBe(true)
    // Task hidden from Downloads UI immediately.
    expect(deps.taskManager.remove).toHaveBeenCalledWith('m-q')
    expect(deps.magnetTracker.markPendingUserDelete).toHaveBeenCalledWith('m-q')
    expect(deps.taskPersistence.runExclusivePersistence).toHaveBeenCalledOnce()
  })
})
