import { Events } from '@shared/protocol/events'
import type { DownloadTask, TaskInstance } from '@shared/types/task'
import {
  makeDefaultBtExtension,
  TaskInstancePhase,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { directTaskUpdatePublication } from '@test-utils/task-update'
import { describe, expect, it, vi } from 'vitest'
import { type FinalizeTaskDeps, finalizeTask } from './finalize-task'

function makeDeps(overrides: Partial<FinalizeTaskDeps> = {}): FinalizeTaskDeps {
  const getById = vi.fn()
  const applyCandidate = (id: string, candidate: DownloadTask) => {
    const current = getById(id) as DownloadTask | undefined
    if (current) Object.assign(current, structuredClone(candidate))
  }
  const taskManager = {
    getById,
    getAll: vi.fn(() => []),
    set: vi.fn(applyCandidate),
    setReservedEngineTaskOwner: vi.fn(applyCandidate),
    reserveEngineTaskId: vi.fn(),
    releaseEngineTaskIdReservation: vi.fn(() => true),
    retireEngineTaskIdReservation: vi.fn(() => true),
    persist: vi.fn(async () => {}),
  } as unknown as FinalizeTaskDeps['taskManager']
  const base = {
    taskManager,
    adapter: {
      removeDownloadResult: vi.fn(async () => {}),
      forceRemoveTask: vi.fn(async () => {}),
      getUploadLength: vi.fn(async () => 0),
      getTaskStatus: vi.fn(async () => null),
      getTaskFiles: vi.fn(async () => []),
      addTorrent: vi.fn(async (params) => params.gid ?? 'new-gid'),
    } as unknown as FinalizeTaskDeps['adapter'],
    fs: {
      renameAtomic: vi.fn(async () => {}),
      removePathRecursive: vi.fn(async () => {}),
    },
    torrentMetaStore: {
      read: vi.fn(async () => new Uint8Array([0])),
    },
    // Default to active seeding so the reseed path is exercised.
    // Tests that need ratio-met / no-seed behavior override this.
    settings: {
      get: vi.fn(() => ({ bt: { seedTime: 60, seedRatio: 1 } })),
    },
    eventBus: { emit: vi.fn() },
    activityRecorder: {
      recordSubmitted: vi.fn(),
      recordDownloadCompleted: vi.fn(),
    },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    recordTransition: vi.fn().mockResolvedValue(undefined),
    createEngineTaskId: () => '0123456789abcdef',
  }
  return { ...base, ...directTaskUpdatePublication(base), ...overrides }
}

function makeTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return makeDownloadTask({
    id: 't1',
    diskPath: '/d/foo.mp4.motrix',
    finalPath: '/d/foo.mp4',
    finalName: 'foo.mp4',
    ...overrides,
  })
}

function makePrimaryInstance(
  overrides: Partial<TaskInstance> = {}
): TaskInstance {
  return {
    instanceId: 'primary:t1',
    motrixId: 't1',
    gid: 'gid-1',
    phase: TaskInstancePhase.HttpDownload,
    status: TaskStatus.Downloading,
    progress: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    uploadedBytes: 0,
    diskPath: '/d/foo.mp4.motrix',
    transitionPhase: TransitionPhase.Idle,
    uris: ['https://example.com/foo.mp4'],
    uriHash: null,
    payload: {},
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
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

describe('finalizeTask HTTP/FTP branch', () => {
  it('performs removeDownloadResult → rename → status=Completed', async () => {
    const deps = makeDeps()
    const task = makeTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(deps.adapter.removeDownloadResult).toHaveBeenCalledWith('gid-1')
    expect(deps.fs.renameAtomic).toHaveBeenCalledWith(
      '/d/foo.mp4.motrix',
      '/d/foo.mp4'
    )
    expect(task.diskPath).toBe('/d/foo.mp4')
    expect(task.status).toBe(TaskStatus.Completed)
    expect(task.finishedAt).not.toBeNull()
    expect(task.transitionPhase).toBe(TransitionPhase.Idle)
  })

  it('rebases the persisted file path after the staging file is renamed', async () => {
    const rebaseTaskFilePaths = vi.fn()
    const deps = makeDeps({ rebaseTaskFilePaths })
    const task = makeTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(rebaseTaskFilePaths).toHaveBeenCalledExactlyOnceWith(
      't1',
      '/d/foo.mp4.motrix',
      '/d/foo.mp4'
    )
  })

  it('still completes when rebasing the persisted file path fails', async () => {
    const rebaseError = new Error('sqlite unavailable')
    const rebaseTaskFilePaths = vi.fn(() => {
      throw rebaseError
    })
    const deps = makeDeps({ rebaseTaskFilePaths })
    const task = makeTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await expect(finalizeTask('t1', deps)).resolves.toBeUndefined()

    expect(task.status).toBe(TaskStatus.Completed)
    expect(deps.log.warn).toHaveBeenCalledWith(
      { err: rebaseError, taskId: 't1' },
      'finalize_http_task_file_path_rebase_failed'
    )
  })

  it('HTTP completion forces an immediate publish, not a coalesced one', async () => {
    const publishTaskUpdate = vi.fn()
    const publishTaskUpdateNow = vi.fn()
    const deps = makeDeps({ publishTaskUpdate, publishTaskUpdateNow })
    const task = makeTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(publishTaskUpdateNow).toHaveBeenCalledTimes(1)
    expect(publishTaskUpdate).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).not.toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.anything()
    )
  })

  it('writes the terminal occurrence with cause "finalize" and dispatches it', async () => {
    const persistTaskWithOccurrence = vi.fn(async () => {})
    const dispatch = vi.fn(async () => {})
    const deps = makeDeps({
      persistTaskWithOccurrence,
      occurrenceDispatcher: { dispatch },
    })
    const task = makeTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(persistTaskWithOccurrence).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 't1', status: TaskStatus.Completed }),
      expect.objectContaining({
        type: 'terminal',
        taskId: 't1',
        fromStatus: TaskStatus.Downloading,
        toStatus: TaskStatus.Completed,
        cause: 'finalize',
      })
    )
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cause: 'finalize' })
    )
  })

  it('records Completed after the durable barrier and before TaskUpdated', async () => {
    const deps = makeDeps()
    const task = makeTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    const persist = deps.taskManager.persist as ReturnType<typeof vi.fn>
    const recordTransition = deps.recordTransition as ReturnType<typeof vi.fn>
    const emit = deps.eventBus.emit as ReturnType<typeof vi.fn>
    expect(recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 't1',
        previousStatus: TaskStatus.Downloading,
        nextStatus: TaskStatus.Completed,
        accuracy: 'exact',
      })
    )
    const completedPersistOrder = persist.mock.invocationCallOrder.at(-1)
    expect(completedPersistOrder).toBeLessThan(
      recordTransition.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
    expect(recordTransition.mock.invocationCallOrder[0]).toBeLessThan(
      emit.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('does not record or emit Completed when its durable barrier fails', async () => {
    const deps = makeDeps()
    const task = makeTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )
    ;(deps.taskManager.persist as ReturnType<typeof vi.fn>).mockImplementation(
      async (candidate: DownloadTask) => {
        if (candidate.status === TaskStatus.Completed) {
          throw new Error('database busy')
        }
      }
    )

    await expect(finalizeTask('t1', deps)).rejects.toThrow('database busy')

    expect(deps.recordTransition).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).not.toHaveBeenCalled()
    expect(task.status).toBe(TaskStatus.Downloading)
    expect(task.transitionPhase).toBe(TransitionPhase.Renaming)
    expect(task.diskPath).toBe('/d/foo.mp4.motrix')
  })

  it('isolates Activity failure after the terminal state is durable', async () => {
    const deps = makeDeps({
      recordTransition: vi
        .fn()
        .mockRejectedValue(new Error('activity database busy')),
    })
    const task = makeTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await expect(finalizeTask('t1', deps)).resolves.toBeUndefined()

    expect(deps.taskManager.persist).toHaveBeenCalled()
    expect(deps.eventBus.emit).toHaveBeenCalled()
    expect(deps.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't1' }),
      'finalize Activity transition recording failed'
    )
  })

  it('records output readiness after rename/path update and before the Completed event', async () => {
    const deps = makeDeps()
    const task = makeTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )
    const recordDownloadCompleted = deps.activityRecorder
      .recordDownloadCompleted as ReturnType<typeof vi.fn>
    const renameAtomic = deps.fs.renameAtomic as ReturnType<typeof vi.fn>
    const emit = deps.eventBus.emit as ReturnType<typeof vi.fn>

    await finalizeTask('t1', deps)

    expect(recordDownloadCompleted).toHaveBeenCalledOnce()
    expect(recordDownloadCompleted).toHaveBeenCalledWith({
      taskId: 't1',
      occurredAt: task.finishedAt,
    })
    expect(renameAtomic.mock.invocationCallOrder[0]).toBeLessThan(
      recordDownloadCompleted.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY
    )
    expect(recordDownloadCompleted.mock.invocationCallOrder[0]).toBeLessThan(
      emit.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('persists transitionPhase=Renaming before rename (intent marker)', async () => {
    const deps = makeDeps()
    const task = makeTask({ instances: [makePrimaryInstance()] })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )
    const persistCalls: Array<{
      taskPhase: TransitionPhase
      instancePhase: TransitionPhase | undefined
    }> = []
    ;(deps.taskManager.persist as ReturnType<typeof vi.fn>).mockImplementation(
      async (t: DownloadTask) => {
        persistCalls.push({
          taskPhase: t.transitionPhase,
          instancePhase: t.instances[0]?.transitionPhase,
        })
      }
    )

    await finalizeTask('t1', deps)

    expect(persistCalls[0]).toEqual({
      taskPhase: TransitionPhase.Renaming,
      instancePhase: TransitionPhase.Renaming,
    })
    expect(persistCalls[persistCalls.length - 1]).toEqual({
      taskPhase: TransitionPhase.Idle,
      instancePhase: TransitionPhase.Idle,
    })
  })

  it('rename failure → status=Error + intent marker preserved', async () => {
    const deps = makeDeps({
      fs: {
        renameAtomic: vi.fn(async () => {
          throw new Error('EACCES')
        }),
        removePathRecursive: vi.fn(async () => {}),
      },
    })
    const task = makeTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await expect(finalizeTask('t1', deps)).rejects.toThrow()
    expect(task.status).toBe(TaskStatus.Error)
    expect(task.finishedAt).not.toBeNull()
    expect(task.errorMessage).toMatch(/rename/i)
    expect(task.errorMessage).toMatch(/EACCES/)
    expect(task.errorDetailKey).toBe('task.error.detail.renameFileFailed')
    expect(task.errorDetailParams).toEqual({ cause: 'EACCES' })
    // Polling never observes stopped rows, so the renderer learns about
    // this Error only through the finalize-side TaskUpdated broadcast.
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Array)
    )
    // transitionPhase stays Renaming for recovery
  })
})

describe('finalizeTask failure-path publication routing', () => {
  it('rename failure forces an immediate publish of the Error state', async () => {
    const publishTaskUpdate = vi.fn()
    const publishTaskUpdateNow = vi.fn()
    const deps = makeDeps({
      publishTaskUpdate,
      publishTaskUpdateNow,
      fs: {
        renameAtomic: vi.fn(async () => {
          throw new Error('EACCES')
        }),
        removePathRecursive: vi.fn(async () => {}),
      },
    })
    const task = makeTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await expect(finalizeTask('t1', deps)).rejects.toThrow()

    expect(task.status).toBe(TaskStatus.Error)
    expect(publishTaskUpdateNow).toHaveBeenCalledTimes(1)
    expect(publishTaskUpdate).not.toHaveBeenCalled()
  })
})

// ─── Pre-finalize byte refresh (super-tiny HTTP race) ────────
//
// Polling only observes active/waiting tasks. A super-tiny HTTP file
// can finish between two polling ticks, so finalize sees totalBytes=0
// and persists Completed with Size 0 / 0%. The fix is a pre-finalize
// tellStatus refresh before removeDownloadResult retires the gid.
describe('finalizeTask HTTP pre-refresh transfer metadata', () => {
  it('fills byte counters and piece length when polling never observed them', async () => {
    const deps = makeDeps()
    const task = makeTask({
      totalBytes: 0,
      downloadedBytes: 0,
      sizeWhenDone: 0,
    })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )
    ;(deps.adapter.getTaskStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        totalBytes: 1234,
        downloadedBytes: 1234,
        sizeWhenDone: 1234,
        pieceLength: 1024,
      } as DownloadTask
    )

    await finalizeTask('t1', deps)

    expect(task.totalBytes).toBe(1234)
    expect(task.sizeWhenDone).toBe(1234)
    expect(task.downloadedBytes).toBe(1234)
    expect(task.pieceLength).toBe(1024)
    expect(task.progress).toBe(1)
    expect(task.status).toBe(TaskStatus.Completed)
  })

  it('chunked-encoding fallback: downloadedBytes>0 + totalBytes=0 → uses received bytes as size', async () => {
    const deps = makeDeps()
    const task = makeTask({
      totalBytes: 0,
      downloadedBytes: 0,
      sizeWhenDone: 0,
    })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )
    // aria2 sometimes never observes a Content-Length (chunked transfer
    // encoding). completedLength is still authoritative — it's the bytes
    // we actually received.
    ;(deps.adapter.getTaskStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        totalBytes: 0,
        downloadedBytes: 7777,
        sizeWhenDone: 0,
      } as DownloadTask
    )

    await finalizeTask('t1', deps)

    expect(task.downloadedBytes).toBe(7777)
    expect(task.totalBytes).toBe(7777)
    expect(task.sizeWhenDone).toBe(7777)
    expect(task.progress).toBe(1)
  })

  it('refresh runs BEFORE removeDownloadResult (gid still alive)', async () => {
    const callOrder: string[] = []
    const deps = makeDeps({
      adapter: {
        removeDownloadResult: vi.fn(async () => {
          callOrder.push('removeDownloadResult')
        }),
        forceRemoveTask: vi.fn(async () => {}),
        getUploadLength: vi.fn(async () => 0),
        getTaskStatus: vi.fn(async () => {
          callOrder.push('getTaskStatus')
          return {
            totalBytes: 50,
            downloadedBytes: 50,
            sizeWhenDone: 50,
          } as DownloadTask
        }),
        getTaskFiles: vi.fn(async () => []),
        addTorrent: vi.fn(async (params) => params.gid ?? 'new-gid'),
      } as unknown as FinalizeTaskDeps['adapter'],
    })
    const task = makeTask({
      totalBytes: 0,
      downloadedBytes: 0,
      sizeWhenDone: 0,
    })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    // Both must run, and refresh must come first — guards against a
    // future regression that skips refresh entirely (which would still
    // satisfy an indexOf-only assertion via -1 < 0).
    expect(callOrder).toContain('getTaskStatus')
    expect(callOrder).toContain('removeDownloadResult')
    expect(callOrder.indexOf('getTaskStatus')).toBeLessThan(
      callOrder.indexOf('removeDownloadResult')
    )
  })

  it('refresh failure is non-fatal: finalize still completes, falls back to existing zeros', async () => {
    const deps = makeDeps({
      adapter: {
        removeDownloadResult: vi.fn(async () => {}),
        forceRemoveTask: vi.fn(async () => {}),
        getUploadLength: vi.fn(async () => 0),
        getTaskStatus: vi.fn(async () => {
          throw new Error('RPC error')
        }),
        getTaskFiles: vi.fn(async () => []),
        addTorrent: vi.fn(async (params) => params.gid ?? 'new-gid'),
      } as unknown as FinalizeTaskDeps['adapter'],
    })
    const task = makeTask({
      totalBytes: 0,
      downloadedBytes: 0,
      sizeWhenDone: 0,
    })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(task.status).toBe(TaskStatus.Completed)
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't1' }),
      'finalize_http_pre_refresh_failed'
    )
  })

  it('does not overwrite already-populated totalBytes (zero never overwrites non-zero)', async () => {
    const deps = makeDeps()
    const task = makeTask({
      totalBytes: 500,
      downloadedBytes: 500,
      sizeWhenDone: 500,
      pieceLength: 256,
    })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )
    // Even if aria2 returned different values, refresh should not touch
    // fields that polling already filled with non-zero. This guards
    // against accidental downgrade.
    ;(deps.adapter.getTaskStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        totalBytes: 999,
        downloadedBytes: 999,
        sizeWhenDone: 999,
        pieceLength: 1024,
      } as DownloadTask
    )

    await finalizeTask('t1', deps)

    // Refresh MUST have been attempted (so the no-overwrite invariant
    // is actually exercised rather than passing trivially because no
    // refresh code exists).
    expect(deps.adapter.getTaskStatus).toHaveBeenCalledWith('gid-1')
    expect(task.totalBytes).toBe(500)
    expect(task.sizeWhenDone).toBe(500)
    expect(task.downloadedBytes).toBe(500)
    expect(task.pieceLength).toBe(256)
  })
})

describe('finalizeTask BT branch', () => {
  function makeBtTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
    return makeTask({
      type: TaskType.Bt,
      diskPath: '/d/torrent.motrix',
      finalPath: '/d/torrent',
      finalName: 'torrent',
      torrentMetaPath: '/u/torrents/t1.torrent',
      bt: makeDefaultBtExtension({
        selectedFiles: [0, 1],
      }),
      ...overrides,
    } as Partial<DownloadTask>)
  }

  it('renames only the indexed payload and reseeds through the restored final name', async () => {
    const workspacePath = '/d/.motrix/0123456789abcdefabcd'
    const renameAtomic = vi.fn(async () => {})
    const removePathRecursive = vi.fn(async () => {})
    const rebaseTaskFilePaths = vi.fn()
    const deps = makeDeps({
      fs: { renameAtomic, removePathRecursive },
      rebaseTaskFilePaths,
      torrentMetaStore: {
        read: vi.fn(async () => buildSingleFileTorrent('original.iso')),
      },
    })
    ;(deps.adapter.getTaskFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        index: 0,
        path: `${workspacePath}/p`,
        size: 1,
        completedBytes: 0,
        selected: false,
      },
    ])
    const task = makeBtTask({
      saveDir: '/d',
      diskPath: workspacePath,
      finalPath: '/d/User chosen.iso',
      finalName: 'User chosen.iso',
      instances: [
        makePrimaryInstance({
          phase: TaskInstancePhase.BtDownload,
          diskPath: workspacePath,
          payload: {
            btStorageLayout: {
              version: 1,
              strategy: 'indexed-staging',
              workspacePath,
              payloadEntry: 'p',
              torrentRootName: 'original.iso',
              multiFile: false,
            },
          },
        }),
      ],
    })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(renameAtomic).toHaveBeenCalledWith(
      `${workspacePath}/p`,
      '/d/User chosen.iso'
    )
    expect(rebaseTaskFilePaths).toHaveBeenCalledWith(
      't1',
      `${workspacePath}/p`,
      '/d/User chosen.iso'
    )
    expect(removePathRecursive).toHaveBeenCalledWith(workspacePath)
    expect(removePathRecursive).not.toHaveBeenCalledWith('/d/User chosen.iso')
    expect(deps.adapter.addTorrent).toHaveBeenCalledWith(
      expect.objectContaining({
        saveDir: '/d',
        outputFilePaths: [{ fileIndex: 0, relativePath: 'User chosen.iso' }],
      })
    )
  })

  it('transitions status→Finalizing before rename', async () => {
    const deps = makeDeps()
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    const statusesSeen: string[] = []
    ;(deps.taskManager.persist as ReturnType<typeof vi.fn>).mockImplementation(
      async (t: DownloadTask) => {
        statusesSeen.push(t.status)
      }
    )

    await finalizeTask('t1', deps)

    expect(statusesSeen).toContain(TaskStatus.Finalizing)
  })

  it('BT finalize publishes intermediate states through the coalescer and never forces them', async () => {
    const publishTaskUpdate = vi.fn()
    const publishTaskUpdateNow = vi.fn()
    const deps = makeDeps({ publishTaskUpdate, publishTaskUpdateNow })
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    // Finalizing and the reseed's Seeding are both non-terminal: they ride
    // the trailing window. No occurrence is produced, so nothing forces.
    expect(publishTaskUpdate.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(publishTaskUpdateNow).not.toHaveBeenCalled()
  })

  it('rename directory failure → status=Error with renameDirFailed detail key', async () => {
    const deps = makeDeps({
      fs: {
        renameAtomic: vi.fn(async () => {
          throw new Error('EACCES')
        }),
        removePathRecursive: vi.fn(async () => {}),
      },
    })
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await expect(finalizeTask('t1', deps)).rejects.toThrow()

    expect(task.status).toBe(TaskStatus.Error)
    expect(task.errorMessage).toMatch(/rename/i)
    expect(task.errorMessage).toMatch(/EACCES/)
    expect(task.errorDetailKey).toBe('task.error.detail.renameDirFailed')
    expect(task.errorDetailParams).toEqual({ cause: 'EACCES' })
    // Polling never observes stopped rows, so the renderer learns about
    // this Error only through the finalize-side TaskUpdated broadcast.
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Array)
    )
  })

  it('snapshots uploadLength BEFORE forceRemoveTask + removeDownloadResult', async () => {
    const callOrder: string[] = []
    const deps = makeDeps({
      adapter: {
        getUploadLength: vi.fn(async () => {
          callOrder.push('getUploadLength')
          return 1024
        }),
        forceRemoveTask: vi.fn(async () => {
          callOrder.push('forceRemoveTask')
        }),
        removeDownloadResult: vi.fn(async () => {
          callOrder.push('removeDownloadResult')
        }),
        addTorrent: vi.fn(async (params) => params.gid ?? 'new-gid'),
      } as unknown as FinalizeTaskDeps['adapter'],
    })
    const task = makeBtTask({ uploadedBytes: 0 })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(callOrder.indexOf('getUploadLength')).toBeLessThan(
      callOrder.indexOf('forceRemoveTask')
    )
    expect(callOrder.indexOf('forceRemoveTask')).toBeLessThan(
      callOrder.indexOf('removeDownloadResult')
    )
    expect(task.uploadedBytes).toBe(1024)
    expect(task.uploadedBytesBaseline).toBe(1024)
  })

  it('lifts the retiring gid uploadLength into uploadedBytesBaseline (no double-count)', async () => {
    // Regression: pre-fix code did `task.uploadedBytes += upload`, which
    // double-counted the snapshot once polling had already mirrored
    // oldGid.uploadLength into task.uploadedBytes. The new accumulator
    // lives on uploadedBytesBaseline; uploadedBytes is the live display
    // value (baseline + currentGidUpload, where current=0 right after
    // forceRemove). Net invariant: baseline only grows, exactly by the
    // retiring gid's contribution.
    const deps = makeDeps({
      adapter: {
        getUploadLength: vi.fn(async () => 5_000_000),
        forceRemoveTask: vi.fn(async () => {}),
        removeDownloadResult: vi.fn(async () => {}),
        addTorrent: vi.fn(async (params) => params.gid ?? 'new-gid'),
      } as unknown as FinalizeTaskDeps['adapter'],
    })
    // Simulate "task has been seeding for a while" — polling has already
    // synced uploadedBytes via mergeEngineTask using the previous session
    // whose baseline was 30 MB and currentGidUpload was 5 MB.
    const task = makeBtTask({
      uploadedBytesBaseline: 30_000_000,
      uploadedBytes: 35_000_000,
    })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(task.uploadedBytesBaseline).toBe(35_000_000)
    expect(task.uploadedBytes).toBe(35_000_000)
  })

  it('forceRemoveTask runs before rename so aria2 releases file handles', async () => {
    const callOrder: string[] = []
    const deps = makeDeps({
      adapter: {
        getUploadLength: vi.fn(async () => 0),
        forceRemoveTask: vi.fn(async () => {
          callOrder.push('forceRemoveTask')
        }),
        removeDownloadResult: vi.fn(async () => {
          callOrder.push('removeDownloadResult')
        }),
        addTorrent: vi.fn(async (params) => params.gid ?? 'new-gid'),
      } as unknown as FinalizeTaskDeps['adapter'],
      fs: {
        renameAtomic: vi.fn(async () => {
          callOrder.push('renameAtomic')
        }),
        removePathRecursive: vi.fn(async () => {}),
      },
    })
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(callOrder.indexOf('forceRemoveTask')).toBeLessThan(
      callOrder.indexOf('renameAtomic')
    )
    expect(callOrder.indexOf('removeDownloadResult')).toBeLessThan(
      callOrder.indexOf('renameAtomic')
    )
  })

  it('records BT output readiness before cleanup and reseed work', async () => {
    const callOrder: string[] = []
    const deps = makeDeps({
      activityRecorder: {
        recordSubmitted: vi.fn(),
        recordDownloadCompleted: vi.fn(() => {
          callOrder.push('record')
        }),
      },
      adapter: {
        getUploadLength: vi.fn(async () => 0),
        getTaskFiles: vi.fn(async () => [
          {
            index: 1,
            path: '/d/torrent.motrix/skipped.bin',
            length: 1,
            completedBytes: 0,
            selected: false,
            uris: [],
          },
        ]),
        forceRemoveTask: vi.fn(async () => {}),
        removeDownloadResult: vi.fn(async () => {}),
        getTaskStatus: vi.fn(async () => null),
        addTorrent: vi.fn(async (params) => {
          callOrder.push('reseed')
          return params.gid ?? 'new-gid'
        }),
      } as unknown as FinalizeTaskDeps['adapter'],
      fs: {
        renameAtomic: vi.fn(async () => {
          callOrder.push('rename')
        }),
        removePathRecursive: vi.fn(async () => {
          callOrder.push('cleanup')
        }),
      },
    })
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(callOrder).toEqual(['rename', 'record', 'cleanup', 'reseed'])
  })

  it('keeps the rename timestamp when cleanup and reseed cross local midnight', async () => {
    const renameTime = new Date(2026, 6, 27, 23, 59, 59, 900).getTime()
    const nextDay = new Date(2026, 6, 28, 0, 0, 0, 100).getTime()
    let now = renameTime
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const cleanupTimes: number[] = []
    const reseedTimes: number[] = []
    const deps = makeDeps({
      adapter: {
        getUploadLength: vi.fn(async () => 0),
        getTaskFiles: vi.fn(async () => [
          {
            index: 1,
            path: '/d/torrent.motrix/skipped.bin',
            length: 1,
            completedBytes: 0,
            selected: false,
            uris: [],
          },
        ]),
        forceRemoveTask: vi.fn(async () => {}),
        removeDownloadResult: vi.fn(async () => {}),
        getTaskStatus: vi.fn(async () => null),
        addTorrent: vi.fn(async (params) => {
          reseedTimes.push(Date.now())
          return params.gid ?? 'new-gid'
        }),
      } as unknown as FinalizeTaskDeps['adapter'],
      fs: {
        renameAtomic: vi.fn(async () => {}),
        removePathRecursive: vi.fn(async () => {
          now = nextDay
          cleanupTimes.push(Date.now())
        }),
      },
    })
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    try {
      await finalizeTask('t1', deps)
    } finally {
      nowSpy.mockRestore()
    }

    expect(deps.activityRecorder.recordDownloadCompleted).toHaveBeenCalledWith({
      taskId: 't1',
      occurredAt: renameTime,
    })
    expect(cleanupTimes).toEqual([nextDay])
    expect(reseedTimes).toEqual([nextDay])
  })

  it('finalize succeeds even when forceRemoveTask throws (gid already gone)', async () => {
    const deps = makeDeps({
      adapter: {
        getUploadLength: vi.fn(async () => 0),
        forceRemoveTask: vi.fn(async () => {
          throw new Error('GID_NOT_FOUND')
        }),
        removeDownloadResult: vi.fn(async () => {}),
        addTorrent: vi.fn(async (params) => params.gid ?? 'new-gid'),
      } as unknown as FinalizeTaskDeps['adapter'],
    })
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(task.engineTaskId).toBe('0123456789abcdef')
    expect(deps.adapter.removeDownloadResult).toHaveBeenCalled()
    expect(deps.fs.renameAtomic).toHaveBeenCalled()
  })

  it('addTorrent uses bt-seed-unverified=true and task metadata', async () => {
    const deps = makeDeps()
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )
    ;(deps.settings.get as ReturnType<typeof vi.fn>).mockReturnValue({
      bt: { seedTime: 60, seedRatio: 1.5 },
    })

    await finalizeTask('t1', deps)

    expect(deps.adapter.addTorrent).toHaveBeenCalledWith({
      metadata: expect.any(Uint8Array),
      saveDir: '/d/torrent',
      selectedFiles: [1, 2],
      seedTime: 60,
      seedRatio: 1.5,
      btSeedUnverified: true,
      pause: false,
      isPrivate: false,
      gid: '0123456789abcdef',
    })
    expect(task.engineTaskId).toBe('0123456789abcdef')
  })

  it('persists and shields the caller-reserved reseed owner before addTorrent', async () => {
    const reservedGid = '0123456789abcdef'
    const order: string[] = []
    const deps = makeDeps()
    const persist = deps.taskManager.persist as ReturnType<typeof vi.fn>
    persist.mockImplementation(async (candidate: DownloadTask) => {
      if (candidate.engineTaskId === reservedGid) order.push('persist-intent')
    })
    ;(
      deps.taskManager.setReservedEngineTaskOwner as ReturnType<typeof vi.fn>
    ).mockImplementation(
      (_id: string, candidate: DownloadTask, gid: string) => {
        expect(gid).toBe(reservedGid)
        order.push('reserved-owner')
        Object.assign(task, structuredClone(candidate))
      }
    )
    ;(deps.adapter.addTorrent as ReturnType<typeof vi.fn>).mockImplementation(
      async (params) => {
        expect(params.gid).toBe(reservedGid)
        expect(deps.taskManager.reserveEngineTaskId).toHaveBeenCalledWith(
          reservedGid
        )
        expect(
          deps.taskManager.setReservedEngineTaskOwner
        ).toHaveBeenCalledOnce()
        order.push('engine')
        return reservedGid
      }
    )
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(order).toEqual(['persist-intent', 'reserved-owner', 'engine'])
    expect(task.engineTaskId).toBe(reservedGid)
  })

  it('does not reseed and releases the reservation when pre-add intent persistence fails', async () => {
    const reservedGid = '0123456789abcdef'
    const failure = new Error('intent persistence failed')
    const deps = makeDeps()
    ;(deps.taskManager.persist as ReturnType<typeof vi.fn>).mockImplementation(
      async (candidate: DownloadTask) => {
        if (candidate.engineTaskId === reservedGid) throw failure
      }
    )
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await expect(finalizeTask('t1', deps)).rejects.toBe(failure)

    expect(deps.adapter.addTorrent).not.toHaveBeenCalled()
    expect(
      deps.taskManager.releaseEngineTaskIdReservation
    ).toHaveBeenCalledWith(reservedGid)
  })

  it('keeps the reserved reseed candidate as owner when add cleanup is uncertain', async () => {
    const reservedGid = '0123456789abcdef'
    const failure = new Error('transport lost after add')
    const deps = makeDeps()
    ;(deps.adapter.addTorrent as ReturnType<typeof vi.fn>).mockRejectedValue(
      failure
    )
    ;(
      deps.adapter.forceRemoveTask as ReturnType<typeof vi.fn>
    ).mockImplementation(async (gid: string) => {
      if (gid === reservedGid) throw new Error('cleanup transport lost')
    })
    ;(
      deps.adapter.removeDownloadResult as ReturnType<typeof vi.fn>
    ).mockImplementation(async (gid: string) => {
      if (gid === reservedGid) throw new Error('result cleanup transport lost')
    })
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await expect(finalizeTask('t1', deps)).rejects.toBe(failure)

    expect(task.engineTaskId).toBe(reservedGid)
    expect(task.status).toBe(TaskStatus.Seeding)
    expect(
      deps.taskManager.retireEngineTaskIdReservation
    ).not.toHaveBeenCalled()
  })

  it('passes isPrivate=true to addTorrent for private torrents', async () => {
    const deps = makeDeps()
    const task = makeBtTask({
      bt: {
        isPrivate: true,
        selectedFiles: [],
        peers: 0,
        seeds: 0,
        ratio: 0,
        trackers: [],
        peersInSwarm: 0,
        seedsInSwarm: 0,
        announceList: [],
        comment: null,
        magnetUri: null,
        sequentialDownload: false,
      },
    })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(deps.adapter.addTorrent).toHaveBeenCalledWith(
      expect.objectContaining({ isPrivate: true })
    )
  })

  it('status=Seeding when seedTime>0 or seedRatio>0', async () => {
    const deps = makeDeps()
    ;(deps.settings.get as ReturnType<typeof vi.fn>).mockReturnValue({
      bt: { seedTime: 60, seedRatio: 0 },
    })
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(task.status).toBe(TaskStatus.Seeding)
  })

  it('status=Completed when both seedTime and seedRatio are 0', async () => {
    const deps = makeDeps()
    ;(deps.settings.get as ReturnType<typeof vi.fn>).mockReturnValue({
      bt: { seedTime: 0, seedRatio: 0 },
    })
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(task.status).toBe(TaskStatus.Completed)
  })

  it('addTorrent failure → status=Completed + soft warning', async () => {
    const deps = makeDeps({
      adapter: {
        removeDownloadResult: vi.fn(async () => {}),
        forceRemoveTask: vi.fn(async () => {}),
        getUploadLength: vi.fn(async () => 0),
        addTorrent: vi.fn(async () => {
          throw new Error('RPC error')
        }),
      } as unknown as FinalizeTaskDeps['adapter'],
    })
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(task.status).toBe(TaskStatus.Completed)
    expect(task.errorMessage).toMatch(/seeding/i)
  })

  it('missing torrent metadata → soft warning', async () => {
    const deps = makeDeps({
      torrentMetaStore: {
        read: vi.fn(async () => {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        }),
      },
    })
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(task.status).toBe(TaskStatus.Completed)
    expect(task.errorMessage).toMatch(/metadata/i)
  })

  it('subtracts already-uploaded ratio from settings ratio when reseeding', async () => {
    const deps = makeDeps()
    ;(deps.settings.get as ReturnType<typeof vi.fn>).mockReturnValue({
      bt: { seedTime: 60, seedRatio: 2 },
    })
    // 1 GB torrent, 800 MB already uploaded across prior sessions →
    // alreadyRatio = 0.8, remainingRatio = 2 - 0.8 = 1.2
    const task = makeBtTask({
      totalBytes: 1_000_000_000,
      uploadedBytesBaseline: 800_000_000,
    })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    const call = (deps.adapter.addTorrent as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
    expect(call.seedRatio).toBeCloseTo(1.2, 5)
    expect(call.seedTime).toBe(60)
    expect(task.status).toBe(TaskStatus.Seeding)
  })

  it('skips reseed and marks Completed when target ratio already met (no time requested)', async () => {
    const deps = makeDeps()
    ;(deps.settings.get as ReturnType<typeof vi.fn>).mockReturnValue({
      bt: { seedTime: 0, seedRatio: 1 },
    })
    // alreadyRatio = 1.5, target ratio = 1.0 → remainingRatio = 0
    const task = makeBtTask({
      totalBytes: 1_000_000,
      uploadedBytesBaseline: 1_500_000,
    })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(deps.adapter.addTorrent).not.toHaveBeenCalled()
    expect(task.status).toBe(TaskStatus.Completed)
    expect(task.transitionPhase).toBe(TransitionPhase.Idle)
    expect(task.engineTaskId).toBe('gid-1')
  })

  it('still reseeds when ratio is met but seedTime is requested (passes seedRatio=0 to ignore ratio)', async () => {
    const deps = makeDeps()
    ;(deps.settings.get as ReturnType<typeof vi.fn>).mockReturnValue({
      bt: { seedTime: 30, seedRatio: 1 },
    })
    const task = makeBtTask({
      totalBytes: 1_000_000,
      uploadedBytesBaseline: 1_500_000,
    })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    const call = (deps.adapter.addTorrent as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
    expect(call.seedRatio).toBe(0)
    expect(call.seedTime).toBe(30)
    expect(task.status).toBe(TaskStatus.Seeding)
  })

  it('does not subtract when totalBytes is 0 (degenerate metadata)', async () => {
    const deps = makeDeps()
    ;(deps.settings.get as ReturnType<typeof vi.fn>).mockReturnValue({
      bt: { seedTime: 60, seedRatio: 1.5 },
    })
    const task = makeBtTask({
      totalBytes: 0,
      uploadedBytesBaseline: 0,
    })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    const call = (deps.adapter.addTorrent as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
    expect(call.seedRatio).toBe(1.5)
  })

  // ─── Unselected-file cleanup ──────────────────────────────────────

  it('snapshots getTaskFiles BEFORE forceRemoveTask (gid still alive)', async () => {
    const callOrder: string[] = []
    const deps = makeDeps({
      adapter: {
        getUploadLength: vi.fn(async () => 0),
        getTaskFiles: vi.fn(async () => {
          callOrder.push('getTaskFiles')
          return []
        }),
        forceRemoveTask: vi.fn(async () => {
          callOrder.push('forceRemoveTask')
        }),
        removeDownloadResult: vi.fn(async () => {}),
        addTorrent: vi.fn(async (params) => params.gid ?? 'new-gid'),
      } as unknown as FinalizeTaskDeps['adapter'],
    })
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(callOrder.indexOf('getTaskFiles')).toBeLessThan(
      callOrder.indexOf('forceRemoveTask')
    )
  })

  it('removes unselected files from finalPath after rename', async () => {
    const removed: string[] = []
    const deps = makeDeps({
      adapter: {
        getUploadLength: vi.fn(async () => 0),
        getTaskFiles: vi.fn(async () => [
          {
            index: 0,
            path: '/d/torrent.motrix/a.txt',
            size: 10,
            completedBytes: 10,
            selected: true,
          },
          {
            index: 1,
            path: '/d/torrent.motrix/b.txt',
            size: 10,
            completedBytes: 0,
            selected: false,
          },
          {
            index: 2,
            path: '/d/torrent.motrix/sub/c.txt',
            size: 10,
            completedBytes: 0,
            selected: false,
          },
        ]),
        forceRemoveTask: vi.fn(async () => {}),
        removeDownloadResult: vi.fn(async () => {}),
        addTorrent: vi.fn(async (params) => params.gid ?? 'new-gid'),
      } as unknown as FinalizeTaskDeps['adapter'],
      fs: {
        renameAtomic: vi.fn(async () => {}),
        removePathRecursive: vi.fn(async (p: string) => {
          removed.push(p)
        }),
      },
    })
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    // a.txt (selected) should NOT be removed; b.txt and sub/c.txt should.
    // Paths are rebased to finalPath.
    expect(removed).toEqual(['/d/torrent/b.txt', '/d/torrent/sub/c.txt'])
  })

  it('idempotent with aria2 own cleanup (removePathRecursive ignores ENOENT)', async () => {
    // Simulates aria2's --bt-remove-unselected-file=true having already
    // removed files. removePathRecursive is documented as ignoring
    // ENOENT, so finalize just logs and continues.
    const deps = makeDeps({
      adapter: {
        getUploadLength: vi.fn(async () => 0),
        getTaskFiles: vi.fn(async () => [
          {
            index: 0,
            path: '/d/torrent.motrix/b.txt',
            size: 10,
            completedBytes: 0,
            selected: false,
          },
        ]),
        forceRemoveTask: vi.fn(async () => {}),
        removeDownloadResult: vi.fn(async () => {}),
        addTorrent: vi.fn(async (params) => params.gid ?? 'new-gid'),
      } as unknown as FinalizeTaskDeps['adapter'],
      fs: {
        renameAtomic: vi.fn(async () => {}),
        // production helper uses fs.rm({force:true}) which silently
        // succeeds on ENOENT — tests just need to confirm no throw.
        removePathRecursive: vi.fn(async () => {}),
      },
    })
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await expect(finalizeTask('t1', deps)).resolves.toBeUndefined()
  })

  it('does not throw if getTaskFiles fails (cleanup falls back to aria2)', async () => {
    const deps = makeDeps({
      adapter: {
        getUploadLength: vi.fn(async () => 0),
        getTaskFiles: vi.fn(async () => {
          throw new Error('rpc timeout')
        }),
        forceRemoveTask: vi.fn(async () => {}),
        removeDownloadResult: vi.fn(async () => {}),
        addTorrent: vi.fn(async (params) => params.gid ?? 'new-gid'),
      } as unknown as FinalizeTaskDeps['adapter'],
    })
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await expect(finalizeTask('t1', deps)).resolves.toBeUndefined()
    expect(deps.adapter.addTorrent).toHaveBeenCalled()
  })

  it('does not throw if removePathRecursive fails for one file', async () => {
    const deps = makeDeps({
      adapter: {
        getUploadLength: vi.fn(async () => 0),
        getTaskFiles: vi.fn(async () => [
          {
            index: 0,
            path: '/d/torrent.motrix/b.txt',
            size: 10,
            completedBytes: 0,
            selected: false,
          },
        ]),
        forceRemoveTask: vi.fn(async () => {}),
        removeDownloadResult: vi.fn(async () => {}),
        addTorrent: vi.fn(async (params) => params.gid ?? 'new-gid'),
      } as unknown as FinalizeTaskDeps['adapter'],
      fs: {
        renameAtomic: vi.fn(async () => {}),
        removePathRecursive: vi.fn(async () => {
          throw new Error('EPERM')
        }),
      },
    })
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await expect(finalizeTask('t1', deps)).resolves.toBeUndefined()
    expect(task.status).toBe(TaskStatus.Seeding)
  })

  it('rejects unselected paths that escape diskPath (defensive guard)', async () => {
    const removed: string[] = []
    const deps = makeDeps({
      adapter: {
        getUploadLength: vi.fn(async () => 0),
        getTaskFiles: vi.fn(async () => [
          // pathological: aria2 reports a path outside the task's dir.
          // Should be silently skipped, never deleted.
          {
            index: 0,
            path: '/etc/passwd',
            size: 0,
            completedBytes: 0,
            selected: false,
          },
          {
            index: 1,
            path: '/d/torrent.motrix/legit.txt',
            size: 0,
            completedBytes: 0,
            selected: false,
          },
        ]),
        forceRemoveTask: vi.fn(async () => {}),
        removeDownloadResult: vi.fn(async () => {}),
        addTorrent: vi.fn(async (params) => params.gid ?? 'new-gid'),
      } as unknown as FinalizeTaskDeps['adapter'],
      fs: {
        renameAtomic: vi.fn(async () => {}),
        removePathRecursive: vi.fn(async (p: string) => {
          removed.push(p)
        }),
      },
    })
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(removed).toEqual(['/d/torrent/legit.txt'])
  })

  it('skips cleanup entirely when getTaskFiles returns no unselected files', async () => {
    const deps = makeDeps({
      adapter: {
        getUploadLength: vi.fn(async () => 0),
        getTaskFiles: vi.fn(async () => [
          {
            index: 0,
            path: '/d/torrent.motrix/a.txt',
            size: 10,
            completedBytes: 10,
            selected: true,
          },
        ]),
        forceRemoveTask: vi.fn(async () => {}),
        removeDownloadResult: vi.fn(async () => {}),
        addTorrent: vi.fn(async (params) => params.gid ?? 'new-gid'),
      } as unknown as FinalizeTaskDeps['adapter'],
    })
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(deps.fs.removePathRecursive).not.toHaveBeenCalled()
  })
})

describe('finalizeTask completion-metrics sync', () => {
  // Regression: aria2's onDownloadComplete races the polling tick
  // that would normally bring downloadedBytes up to totalBytes. Without
  // the sync, the task persists as Completed/Seeding with progress < 1
  // and the UI shows "Completed · 87%" forever (the gid is dropped via
  // removeDownloadResult, so no later poll can correct it).
  function makeBtTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
    return makeTask({
      type: TaskType.Bt,
      diskPath: '/d/torrent.motrix',
      finalPath: '/d/torrent',
      finalName: 'torrent',
      torrentMetaPath: '/u/torrents/t1.torrent',
      bt: makeDefaultBtExtension({
        selectedFiles: [0, 1],
      }),
      ...overrides,
    } as Partial<DownloadTask>)
  }

  it('HTTP: bumps downloadedBytes to totalBytes and progress to 1', async () => {
    const deps = makeDeps()
    const task = makeTask({
      totalBytes: 1_000_000,
      downloadedBytes: 870_400,
      progress: 0.87,
    })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(task.status).toBe(TaskStatus.Completed)
    expect(task.downloadedBytes).toBe(1_000_000)
    expect(task.progress).toBe(1)
  })

  it('HTTP: clears the final polling sample runtime metrics at Completed', async () => {
    const deps = makeDeps()
    const task = makeTask({
      downloadSpeed: 8_192,
      uploadSpeed: 256,
      etaSeconds: 2,
      connections: 4,
    })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(task.status).toBe(TaskStatus.Completed)
    expect(task).toMatchObject({
      downloadSpeed: 0,
      uploadSpeed: 0,
      etaSeconds: 0,
      connections: 0,
    })
  })

  it('HTTP: skips sync when totalBytes is 0 (chunked-encoding edge case)', async () => {
    const deps = makeDeps()
    const task = makeTask({
      totalBytes: 0,
      downloadedBytes: 0,
      progress: 0,
    })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(task.status).toBe(TaskStatus.Completed)
    expect(task.totalBytes).toBe(0)
    expect(task.downloadedBytes).toBe(0)
    expect(task.progress).toBe(0)
  })

  it('BT skip-reseed (ratio=0, time=0): progress reaches 1 at Completed', async () => {
    const deps = makeDeps()
    ;(deps.settings.get as ReturnType<typeof vi.fn>).mockReturnValue({
      bt: { seedTime: 0, seedRatio: 0 },
    })
    const task = makeBtTask({
      totalBytes: 1_000_000_000,
      downloadedBytes: 999_998_976,
      progress: 0.999998976,
    })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(task.status).toBe(TaskStatus.Completed)
    expect(task.downloadedBytes).toBe(1_000_000_000)
    expect(task.progress).toBe(1)
  })

  it('BT seeding-fail path: progress reaches 1 at soft-Completed', async () => {
    const deps = makeDeps({
      adapter: {
        removeDownloadResult: vi.fn(async () => {}),
        forceRemoveTask: vi.fn(async () => {}),
        getUploadLength: vi.fn(async () => 0),
        getTaskFiles: vi.fn(async () => []),
        addTorrent: vi.fn(async () => {
          throw new Error('RPC down')
        }),
      } as unknown as FinalizeTaskDeps['adapter'],
    })
    const task = makeBtTask({
      totalBytes: 1_000_000,
      downloadedBytes: 900_000,
      progress: 0.9,
    })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(task.status).toBe(TaskStatus.Completed)
    expect(task.errorMessage).toMatch(/seeding/i)
    expect(task.downloadedBytes).toBe(1_000_000)
    expect(task.progress).toBe(1)
  })

  it('BT normal reseed: progress reaches 1 at Seeding hand-off', async () => {
    const deps = makeDeps()
    ;(deps.settings.get as ReturnType<typeof vi.fn>).mockReturnValue({
      bt: { seedTime: 60, seedRatio: 1 },
    })
    const task = makeBtTask({
      totalBytes: 1_000_000,
      downloadedBytes: 950_000,
      progress: 0.95,
    })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(task.status).toBe(TaskStatus.Seeding)
    expect(task.downloadedBytes).toBe(1_000_000)
    expect(task.progress).toBe(1)
  })
})

describe('finalizeTask re-entry guards', () => {
  it('makes a repeated HTTP completion callback a no-op', async () => {
    const deps = makeDeps()
    const task = makeTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)
    await finalizeTask('t1', deps)

    expect(deps.fs.renameAtomic).toHaveBeenCalledTimes(1)
    expect(deps.adapter.removeDownloadResult).toHaveBeenCalledTimes(1)
    expect(deps.activityRecorder.recordDownloadCompleted).toHaveBeenCalledTimes(
      1
    )
  })

  it('makes a repeated BT callback after the Seeding hand-off a no-op', async () => {
    const deps = makeDeps()
    const task = makeTask({
      type: TaskType.Bt,
      diskPath: '/d/torrent.motrix',
      finalPath: '/d/torrent',
      finalName: 'torrent',
      torrentMetaPath: '/u/torrents/t1.torrent',
      bt: makeDefaultBtExtension({
        selectedFiles: [0, 1],
      }),
    })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)
    await finalizeTask('t1', deps)

    expect(task.status).toBe(TaskStatus.Seeding)
    expect(deps.fs.renameAtomic).toHaveBeenCalledTimes(1)
    expect(deps.adapter.addTorrent).toHaveBeenCalledTimes(1)
    expect(deps.activityRecorder.recordDownloadCompleted).toHaveBeenCalledTimes(
      1
    )
  })

  it('coalesces concurrent callbacks while the first finalization is in flight', async () => {
    let releaseRename!: () => void
    const renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve
    })
    const deps = makeDeps({
      fs: {
        renameAtomic: vi.fn(() => renameGate),
        removePathRecursive: vi.fn(async () => {}),
      },
    })
    const task = makeTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    const first = finalizeTask('t1', deps)
    await vi.waitFor(() => {
      expect(deps.fs.renameAtomic).toHaveBeenCalledOnce()
    })
    await expect(finalizeTask('t1', deps)).resolves.toBeUndefined()
    releaseRename()
    await first

    expect(deps.fs.renameAtomic).toHaveBeenCalledTimes(1)
    expect(deps.activityRecorder.recordDownloadCompleted).toHaveBeenCalledTimes(
      1
    )
  })
})

describe('finalizeTask plugin-hook chain (Plan C / T15)', () => {
  function makeBtTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
    return makeTask({
      type: TaskType.Bt,
      diskPath: '/d/torrent.motrix',
      finalPath: '/d/torrent',
      finalName: 'torrent',
      torrentMetaPath: '/u/torrents/t1.torrent',
      bt: {
        infoHash: 'abc123',
        selectedFiles: [0, 1],
      },
      ...overrides,
    } as Partial<DownloadTask>)
  }

  function makeBeforeFinalizeCommit(
    overrides: {
      finalFilePath?: string
      staged?: {
        commitMetadata: ReturnType<typeof vi.fn>
      }
    } = {}
  ) {
    return {
      final: {
        sourceUrl: 'https://a/b',
        createdBy: 'user' as const,
        requestedAt: 0,
        task: {} as DownloadTask,
        filePath: overrides.finalFilePath ?? '/d/foo.mp4',
      },
      finalFilePath: overrides.finalFilePath,
      staged: overrides.staged ?? {
        commitMetadata: vi.fn((_db, _id, cb) => cb()),
      },
    }
  }

  function makeOrchestrator(
    result:
      | { aborted: true; reason: string }
      | ReturnType<typeof makeBeforeFinalizeCommit>
  ): FinalizeTaskDeps['orchestrator'] {
    return {
      runBeforeFinalize: vi.fn().mockResolvedValue(result),
      runParallel: vi.fn(async () => {}),
      runBeforeCreateHttp: vi.fn(),
    } as unknown as FinalizeTaskDeps['orchestrator']
  }

  function makeAuditLog(): FinalizeTaskDeps['auditLog'] {
    return {
      log: vi.fn(async () => {}),
    } as unknown as FinalizeTaskDeps['auditLog']
  }

  it('HTTP: chain commit + afterComplete fires on success', async () => {
    const orchestrator = makeOrchestrator(makeBeforeFinalizeCommit())
    const auditLog = makeAuditLog()
    const deps: FinalizeTaskDeps = {
      ...makeDeps(),
      orchestrator,
      auditLog,
    }
    const task = makeTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(orchestrator?.runBeforeFinalize).toHaveBeenCalledOnce()
    expect(auditLog?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chain.commit',
        hook: 'beforeFinalize',
        taskId: 't1',
      })
    )
    expect(task.status).toBe(TaskStatus.Completed)
    expect(orchestrator?.runParallel).toHaveBeenCalledWith(
      'afterComplete',
      expect.objectContaining({ filePath: '/d/foo.mp4' }),
      't1'
    )
  })

  it('HTTP: chain abort leaves task Error + fires onError; rename skipped', async () => {
    const orchestrator = makeOrchestrator({
      aborted: true,
      reason: 'plugin sad',
    })
    const auditLog = makeAuditLog()
    const deps: FinalizeTaskDeps = {
      ...makeDeps(),
      orchestrator,
      auditLog,
    }
    const task = makeTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(task.status).toBe(TaskStatus.Error)
    expect(task.errorMessage).toMatch(/plugin sad/)
    expect(task.errorDetailKey).toBe('task.error.detail.pluginChainAborted')
    expect(task.errorDetailParams).toEqual({ cause: 'plugin sad' })
    // rename never attempted
    expect(deps.fs.renameAtomic).not.toHaveBeenCalled()
    expect(deps.adapter.removeDownloadResult).not.toHaveBeenCalled()
    expect(auditLog?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chain.abort',
        hook: 'beforeFinalize',
        reason: 'plugin sad',
      })
    )
    expect(orchestrator?.runParallel).toHaveBeenCalledWith(
      'onError',
      expect.objectContaining({
        error: expect.objectContaining({ code: 'PLUGIN_RUNTIME_FAULT' }),
      }),
      't1'
    )
    // Polling never observes stopped rows, so the renderer learns about
    // this Error only through the finalize-side TaskUpdated broadcast.
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Array)
    )
  })

  it('BT: chain abort leaves task Error + fires onError; rename skipped', async () => {
    const orchestrator = makeOrchestrator({
      aborted: true,
      reason: 'plugin sad',
    })
    const auditLog = makeAuditLog()
    const deps: FinalizeTaskDeps = {
      ...makeDeps(),
      orchestrator,
      auditLog,
    }
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(task.status).toBe(TaskStatus.Error)
    expect(task.errorMessage).toMatch(/plugin sad/)
    expect(task.errorDetailKey).toBe('task.error.detail.pluginChainAborted')
    expect(task.errorDetailParams).toEqual({ cause: 'plugin sad' })
    expect(deps.fs.renameAtomic).not.toHaveBeenCalled()
  })

  it('HTTP: chain-decided finalFilePath drives renameAtomic dst', async () => {
    const orchestrator = makeOrchestrator(
      makeBeforeFinalizeCommit({ finalFilePath: '/d/foo-rewritten.mp4' })
    )
    const rebaseTaskFilePaths = vi.fn()
    const deps: FinalizeTaskDeps = {
      ...makeDeps({ rebaseTaskFilePaths }),
      orchestrator,
      auditLog: makeAuditLog(),
    }
    const task = makeTask()
    const persistedPaths: string[] = []
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )
    ;(deps.taskManager.persist as ReturnType<typeof vi.fn>).mockImplementation(
      async (persisted: DownloadTask) => {
        persistedPaths.push(persisted.finalPath)
      }
    )

    await finalizeTask('t1', deps)

    expect(deps.fs.renameAtomic).toHaveBeenCalledWith(
      '/d/foo.mp4.motrix',
      '/d/foo-rewritten.mp4'
    )
    expect(rebaseTaskFilePaths).toHaveBeenCalledWith(
      't1',
      '/d/foo.mp4.motrix',
      '/d/foo-rewritten.mp4'
    )
    expect(persistedPaths.slice(0, 2)).toEqual([
      '/d/foo.mp4',
      '/d/foo-rewritten.mp4',
    ])
    expect(
      (deps.taskManager.persist as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[1]
    ).toBeLessThan(
      (deps.fs.renameAtomic as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
    expect(task.finalPath).toBe('/d/foo-rewritten.mp4')
  })

  it('BT: persists a plugin-rewritten finalPath before the rename', async () => {
    const orchestrator = makeOrchestrator(
      makeBeforeFinalizeCommit({ finalFilePath: '/d/torrent-rewritten' })
    )
    const deps: FinalizeTaskDeps = {
      ...makeDeps(),
      orchestrator,
      auditLog: makeAuditLog(),
    }
    const task = makeBtTask()
    const persistedPaths: string[] = []
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )
    ;(deps.taskManager.persist as ReturnType<typeof vi.fn>).mockImplementation(
      async (persisted: DownloadTask) => {
        persistedPaths.push(persisted.finalPath)
      }
    )

    await finalizeTask('t1', deps)

    expect(deps.fs.renameAtomic).toHaveBeenCalledWith(
      '/d/torrent.motrix',
      '/d/torrent-rewritten'
    )
    expect(persistedPaths.slice(0, 3)).toEqual([
      '/d/torrent',
      '/d/torrent-rewritten',
      '/d/torrent-rewritten',
    ])
    const persist = deps.taskManager.persist as ReturnType<typeof vi.fn>
    const rename = deps.fs.renameAtomic as ReturnType<typeof vi.fn>
    expect(persist.mock.invocationCallOrder[1]).toBeLessThan(
      rename.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('BT skip-reseed: afterComplete fires on Completed transition', async () => {
    const orchestrator = makeOrchestrator(makeBeforeFinalizeCommit())
    const deps: FinalizeTaskDeps = {
      ...makeDeps(),
      orchestrator,
      auditLog: makeAuditLog(),
    }
    ;(deps.settings.get as ReturnType<typeof vi.fn>).mockReturnValue({
      bt: { seedTime: 0, seedRatio: 0 },
    })
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(task.status).toBe(TaskStatus.Completed)
    expect(orchestrator?.runParallel).toHaveBeenCalledWith(
      'afterComplete',
      expect.objectContaining({ task: expect.any(Object) }),
      't1'
    )
  })

  it('BT seeding-fail path: afterComplete still fires (task ends Completed)', async () => {
    const orchestrator = makeOrchestrator(makeBeforeFinalizeCommit())
    const deps: FinalizeTaskDeps = {
      ...makeDeps({
        adapter: {
          removeDownloadResult: vi.fn(async () => {}),
          forceRemoveTask: vi.fn(async () => {}),
          getUploadLength: vi.fn(async () => 0),
          getTaskFiles: vi.fn(async () => []),
          addTorrent: vi.fn(async () => {
            throw new Error('seed kaput')
          }),
        } as unknown as FinalizeTaskDeps['adapter'],
      }),
      orchestrator,
      auditLog: makeAuditLog(),
    }
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(task.status).toBe(TaskStatus.Completed)
    expect(orchestrator?.runParallel).toHaveBeenCalledWith(
      'afterComplete',
      expect.any(Object),
      't1'
    )
  })

  it('BT normal Seeding hand-off does NOT fire afterComplete', async () => {
    const orchestrator = makeOrchestrator(makeBeforeFinalizeCommit())
    const deps: FinalizeTaskDeps = {
      ...makeDeps(),
      orchestrator,
      auditLog: makeAuditLog(),
    }
    ;(deps.settings.get as ReturnType<typeof vi.fn>).mockReturnValue({
      bt: { seedTime: 60, seedRatio: 1 },
    })
    const task = makeBtTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(task.status).toBe(TaskStatus.Seeding)
    expect(orchestrator?.runParallel).not.toHaveBeenCalled()
  })

  it('absent orchestrator is a no-op (backward compat)', async () => {
    // No orchestrator / auditLog / db set → existing behavior unchanged.
    const deps = makeDeps()
    const task = makeTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(task.status).toBe(TaskStatus.Completed)
  })

  it('parallel hook failure is isolated (does not break finalize)', async () => {
    const orchestrator = {
      runBeforeFinalize: vi.fn().mockResolvedValue(makeBeforeFinalizeCommit()),
      runParallel: vi.fn().mockRejectedValue(new Error('plugin crash')),
      runBeforeCreateHttp: vi.fn(),
    } as unknown as FinalizeTaskDeps['orchestrator']
    const deps: FinalizeTaskDeps = {
      ...makeDeps(),
      orchestrator,
      auditLog: makeAuditLog(),
    }
    const task = makeTask()
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await expect(finalizeTask('t1', deps)).resolves.toBeUndefined()
    // Give the void-promise's .catch handler a tick to run.
    await new Promise((r) => setTimeout(r, 0))
    expect(task.status).toBe(TaskStatus.Completed)
  })
})

// ─── Instance diskPath sync at finalize ──────────────────────
//
// SessionManager.save() persists task_instances from `task.instances`
// verbatim (the top-level task.diskPath is only used when instances is
// empty, via synthesizePrimaryInstance). restore() Pass 2 then rebuilds
// a Completed task's diskPath FROM the primary instance row. If finalize
// only rewrites the top-level diskPath, the stale `.motrix` placeholder
// survives in the instance row and resurrects after an app restart —
// breaking reveal-in-folder and delete-with-files. Mirrors the fix
// already applied in MediaTaskCoordinator (media completion path).
describe('finalizeTask instance diskPath sync', () => {
  function makeInstance(overrides: Partial<TaskInstance> = {}): TaskInstance {
    return {
      instanceId: 'primary:t1',
      motrixId: 't1',
      gid: 'gid-1',
      phase: TaskInstancePhase.HttpDownload,
      status: TaskStatus.Downloading,
      progress: 0,
      totalBytes: 0,
      downloadedBytes: 0,
      uploadedBytes: 0,
      diskPath: '/d/foo.mp4.motrix',
      transitionPhase: TransitionPhase.Idle,
      uris: ['https://example.com/foo.mp4'],
      uriHash: null,
      payload: {},
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    }
  }

  it('HTTP: rewrites every instance diskPath to finalPath and marks it Completed', async () => {
    const deps = makeDeps()
    const task = makeTask({ instances: [makeInstance()] })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(task.instances[0].diskPath).toBe('/d/foo.mp4')
    expect(task.instances[0].status).toBe(TaskStatus.Completed)
    expect(task.instances[0].transitionPhase).toBe(TransitionPhase.Idle)
  })

  it('BT: rewrites every instance diskPath to finalPath', async () => {
    const deps = makeDeps()
    const task = makeTask({
      type: TaskType.Bt,
      diskPath: '/d/torrent.motrix',
      finalPath: '/d/torrent',
      finalName: 'torrent',
      torrentMetaPath: '/u/torrents/t1.torrent',
      instances: [
        makeInstance({
          phase: TaskInstancePhase.BtDownload,
          diskPath: '/d/torrent.motrix',
          uris: [],
        }),
      ],
    })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(task.instances[0].diskPath).toBe('/d/torrent')
    expect(task.instances[0]).toMatchObject({
      gid: '0123456789abcdef',
      status: TaskStatus.Seeding,
      transitionPhase: TransitionPhase.Idle,
    })
  })

  it('HTTP: honors a plugin-overridden finalFilePath in instance rows too', async () => {
    const orchestrator = {
      runBeforeFinalize: vi.fn().mockResolvedValue({
        final: {
          sourceUrl: 'https://a/b',
          createdBy: 'user' as const,
          requestedAt: 0,
          task: {} as DownloadTask,
          filePath: '/d/renamed.mp4',
        },
        finalFilePath: '/d/renamed.mp4',
        staged: { commitMetadata: vi.fn((_db, _id, cb) => cb()) },
      }),
      runParallel: vi.fn().mockResolvedValue(undefined),
      runBeforeCreateHttp: vi.fn(),
    } as unknown as FinalizeTaskDeps['orchestrator']
    const deps: FinalizeTaskDeps = {
      ...makeDeps(),
      orchestrator,
    }
    const task = makeTask({ instances: [makeInstance()] })
    ;(deps.taskManager.getById as ReturnType<typeof vi.fn>).mockReturnValue(
      task
    )

    await finalizeTask('t1', deps)

    expect(task.diskPath).toBe('/d/renamed.mp4')
    expect(task.instances[0].diskPath).toBe('/d/renamed.mp4')
  })
})
