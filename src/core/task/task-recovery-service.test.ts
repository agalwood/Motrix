import { ErrorCode } from '@shared/errors'
import type { DownloadTask } from '@shared/types/task'
import {
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { TaskActivityAccuracy } from '@shared/types/task-activity'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it, vi } from 'vitest'
import {
  determineAction,
  RecoveryAction,
  type RecoveryDeps,
  type RecoveryFs,
  TaskRecoveryServiceImpl,
} from './task-recovery-service'

describe('determineAction', () => {
  const make = (overrides = {}) => ({
    phase: TransitionPhase.Renaming,
    fsState: 'temp_only' as 'temp_only' | 'final_only' | 'both' | 'neither',
    aria2HasMatchingInfoHash: false,
    taskType: TaskType.Bt,
    ...overrides,
  })

  it('Renaming + temp_only → ResumeFromRename', () => {
    expect(determineAction(make())).toBe(RecoveryAction.ResumeFromRename)
  })

  it('Renaming + final_only + BT → ResumeFromReseed', () => {
    expect(
      determineAction(make({ fsState: 'final_only', taskType: TaskType.Bt }))
    ).toBe(RecoveryAction.ResumeFromReseed)
  })

  it('Renaming + final_only + HTTP → MarkCompleted', () => {
    expect(
      determineAction(make({ fsState: 'final_only', taskType: TaskType.Http }))
    ).toBe(RecoveryAction.MarkCompleted)
  })

  it('Renaming + both → MarkError without guessing which output is valid', () => {
    expect(determineAction(make({ fsState: 'both' }))).toBe(
      RecoveryAction.MarkError
    )
    expect(
      determineAction(make({ fsState: 'both', taskType: TaskType.Http }))
    ).toBe(RecoveryAction.MarkError)
  })

  it('Renaming + neither → MarkError', () => {
    expect(determineAction(make({ fsState: 'neither' }))).toBe(
      RecoveryAction.MarkError
    )
  })

  it('Reseeding + final_only + no aria2 match → ResumeFromReseed', () => {
    expect(
      determineAction(
        make({
          phase: TransitionPhase.Reseeding,
          fsState: 'final_only',
          aria2HasMatchingInfoHash: false,
        })
      )
    ).toBe(RecoveryAction.ResumeFromReseed)
  })

  it('Reseeding + final_only + aria2 match → AdoptExistingGid', () => {
    expect(
      determineAction(
        make({
          phase: TransitionPhase.Reseeding,
          fsState: 'final_only',
          aria2HasMatchingInfoHash: true,
        })
      )
    ).toBe(RecoveryAction.AdoptExistingGid)
  })

  it('Reseeding + temp_only → ResumeFromRename (rollback)', () => {
    expect(
      determineAction(
        make({ phase: TransitionPhase.Reseeding, fsState: 'temp_only' })
      )
    ).toBe(RecoveryAction.ResumeFromRename)
  })

  it('Reseeding + neither → MarkError', () => {
    expect(
      determineAction(
        make({ phase: TransitionPhase.Reseeding, fsState: 'neither' })
      )
    ).toBe(RecoveryAction.MarkError)
  })

  it('Idle phase → NoOp', () => {
    expect(determineAction(make({ phase: TransitionPhase.Idle }))).toBe(
      RecoveryAction.NoOp
    )
  })
})

function makeTask(overrides = {}) {
  return makeDownloadTask({
    id: 't1',
    type: TaskType.Bt,
    status: TaskStatus.Finalizing,
    diskPath: '/d/foo.motrix',
    finalPath: '/d/foo',
    finalName: 'foo',
    transitionPhase: TransitionPhase.Renaming,
    ...overrides,
  })
}

function makeFs(existing: Set<string>): RecoveryFs {
  return {
    pathExists: vi.fn(async (p: string) => existing.has(p)),
    renameAtomic: vi.fn(async (src: string, dst: string) => {
      existing.delete(src)
      existing.add(dst)
    }),
    removePathRecursive: vi.fn(async (p: string) => {
      existing.delete(p)
    }),
  }
}

function makeDeps(overrides: Partial<RecoveryDeps> = {}): RecoveryDeps {
  return {
    taskManager: {
      getAll: vi.fn(() => []),
      persist: vi.fn(async () => {}),
    },
    adapter: {
      listActiveAndWaiting: vi.fn(async () => []),
    },
    fs: makeFs(new Set()),
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
    recordTransition: vi.fn().mockResolvedValue(undefined),
    // MarkError's diagnostic upgrade (task.error.detail.*) needs a CAS
    // backing store + dispatcher. A default fake that always claims the
    // upgrade "changed" lets every test exercise the real path without
    // per-test boilerplate; tests asserting on the DB/dispatch calls
    // themselves override these.
    db: { applyDiagnosisUpgradeRow: vi.fn(() => 'updated' as const) },
    occurrenceDispatcher: { dispatch: vi.fn(async () => {}) },
    ...overrides,
  }
}

describe('TaskRecoveryServiceImpl.recoverOnStartup', () => {
  it('reports 0 scanned and 0 recovered when no in-flight tasks', async () => {
    const deps = makeDeps({
      taskManager: {
        getAll: vi.fn(() => [
          makeTask({
            id: 'idle-1',
            transitionPhase: TransitionPhase.Idle,
            status: TaskStatus.Completed,
          }),
        ]),
        persist: vi.fn(async () => {}),
      },
    })
    const svc = new TaskRecoveryServiceImpl(deps)

    const report = await svc.recoverOnStartup()

    expect(report.totalScanned).toBe(0)
    expect(report.recovered).toHaveLength(0)
    expect(report.warnings).toHaveLength(0)
    expect(report.errors).toHaveLength(0)
    expect(deps.finalizeTask).not.toHaveBeenCalled()
  })

  it('invokes finalizeTask once for a BT task in Renaming with temp file present', async () => {
    const task = makeTask({
      id: 'bt-1',
      type: TaskType.Bt,
      transitionPhase: TransitionPhase.Renaming,
      status: TaskStatus.Finalizing,
      diskPath: '/d/torrent.motrix',
      finalPath: '/d/torrent',
    })
    const finalize = vi.fn(async () => {})
    const deps = makeDeps({
      taskManager: {
        getAll: vi.fn(() => [task]),
        persist: vi.fn(async () => {}),
      },
      fs: makeFs(new Set(['/d/torrent.motrix'])),
      finalizeTask: finalize,
    })
    const svc = new TaskRecoveryServiceImpl(deps)

    const report = await svc.recoverOnStartup()

    expect(report.totalScanned).toBe(1)
    expect(finalize).toHaveBeenCalledTimes(1)
    expect(finalize).toHaveBeenCalledWith('bt-1')
    expect(report.recovered).toEqual([
      { taskId: 'bt-1', action: RecoveryAction.ResumeFromRename },
    ])
    expect(report.errors).toHaveLength(0)
  })

  it('probes the indexed payload instead of the sidecar workspace on recovery', async () => {
    const workspacePath = '/d/.motrix/0123456789abcdefabcd'
    const task = makeTask({
      id: 'bt-indexed',
      saveDir: '/d',
      diskPath: workspacePath,
      finalPath: '/d/final-name',
      instances: [
        {
          instanceId: 'primary:bt-indexed',
          motrixId: 'bt-indexed',
          gid: 'gid-indexed',
          phase: TaskInstancePhase.BtDownload,
          status: TaskStatus.Finalizing,
          progress: 1,
          totalBytes: 10,
          downloadedBytes: 10,
          uploadedBytes: 0,
          diskPath: workspacePath,
          transitionPhase: TransitionPhase.Renaming,
          uris: [],
          uriHash: null,
          payload: {
            btStorageLayout: {
              version: 1,
              strategy: 'indexed-staging',
              workspacePath,
              payloadEntry: 'p',
              torrentRootName: 'original-name',
              multiFile: true,
            },
          },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    })
    const fs = makeFs(new Set([`${workspacePath}/p`]))
    const finalizeTask = vi.fn(async () => {})
    const deps = makeDeps({
      taskManager: {
        getAll: vi.fn(() => [task]),
        persist: vi.fn(async () => {}),
      },
      fs,
      finalizeTask,
    })

    const report = await new TaskRecoveryServiceImpl(deps).recoverOnStartup()

    expect(fs.pathExists).toHaveBeenCalledWith(`${workspacePath}/p`)
    expect(fs.pathExists).not.toHaveBeenCalledWith(workspacePath)
    expect(finalizeTask).toHaveBeenCalledWith('bt-indexed')
    expect(report.recovered[0]?.action).toBe(RecoveryAction.ResumeFromRename)
  })

  it('treats an existing same diskPath/finalPath as final_only and records recovered before reseed', async () => {
    const task = makeTask({
      id: 'same-path',
      transitionPhase: TransitionPhase.Reseeding,
      diskPath: '/d/already-final',
      finalPath: '/d/already-final',
    })
    const fs = makeFs(new Set(['/d/already-final']))
    const finalize = vi.fn(async () => {})
    const deps = makeDeps({
      taskManager: {
        getAll: vi.fn(() => [task]),
        persist: vi.fn(async () => {}),
      },
      fs,
      finalizeTask: finalize,
    })
    const recordDownloadCompleted = deps.activityRecorder
      .recordDownloadCompleted as ReturnType<typeof vi.fn>

    const report = await new TaskRecoveryServiceImpl(deps).recoverOnStartup()

    expect(fs.pathExists).toHaveBeenCalledTimes(1)
    expect(recordDownloadCompleted).toHaveBeenCalledWith({
      taskId: 'same-path',
      occurredAt: expect.any(Number),
      accuracy: TaskActivityAccuracy.Recovered,
    })
    expect(recordDownloadCompleted.mock.invocationCallOrder[0]).toBeLessThan(
      (deps.taskManager.persist as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
    expect(finalize).toHaveBeenCalledWith('same-path')
    expect(report.recovered[0]?.action).toBe(RecoveryAction.ResumeFromReseed)
  })

  it.each([
    ['BT', TaskType.Bt],
    ['HTTP', TaskType.Http],
  ])(
    'preserves both paths and requires manual review for a %s rename conflict',
    async (_label, type) => {
      const task = makeTask({
        id: `both-paths-${type}`,
        type,
        status: TaskStatus.Error,
        errorMessage: 'Failed to rename output: destination already exists',
        transitionPhase: TransitionPhase.Renaming,
        diskPath: '/d/download.motrix',
        finalPath: '/d/download',
      })
      const existing = new Set(['/d/download.motrix', '/d/download'])
      const fs = makeFs(existing)
      const persist = vi.fn(async () => {})
      const deps = makeDeps({
        taskManager: {
          getAll: vi.fn(() => [task]),
          persist,
        },
        fs,
      })

      const report = await new TaskRecoveryServiceImpl(deps).recoverOnStartup()

      expect(fs.removePathRecursive).not.toHaveBeenCalled()
      expect(existing).toEqual(new Set(['/d/download.motrix', '/d/download']))
      expect(deps.finalizeTask).not.toHaveBeenCalled()
      expect(
        deps.activityRecorder.recordDownloadCompleted
      ).not.toHaveBeenCalled()
      expect(task).toMatchObject({
        status: TaskStatus.Error,
        diskPath: '/d/download.motrix',
        finalPath: '/d/download',
        transitionPhase: TransitionPhase.Renaming,
        errorDetailKey: 'task.error.detail.recoveryOutputConflict',
        errorMessage: null,
      })
      expect(
        task.instances.every(
          (instance) =>
            instance.status === TaskStatus.Error &&
            instance.diskPath === '/d/download.motrix' &&
            instance.transitionPhase === TransitionPhase.Renaming
        )
      ).toBe(true)
      expect(persist).toHaveBeenCalledWith(task)
      expect(report.recovered).toHaveLength(0)
      expect(report.errors).toEqual([
        expect.objectContaining({
          taskId: `both-paths-${type}`,
          action: RecoveryAction.MarkError,
          issue: expect.stringContaining('preserved both paths'),
        }),
      ])
      expect(deps.log.error).toHaveBeenCalledWith(
        expect.objectContaining({
          code: ErrorCode.TaskRecoveryFsMismatch,
          taskId: `both-paths-${type}`,
          diskPath: '/d/download.motrix',
          finalPath: '/d/download',
        }),
        'recovery_output_conflict_preserved'
      )
    }
  )

  it('writes the terminal occurrence with cause "recovery" for a MarkError transition and dispatches it', async () => {
    const task = makeTask({
      id: 'recovery-error',
      status: TaskStatus.Downloading,
      transitionPhase: TransitionPhase.Renaming,
      diskPath: '/d/missing.motrix',
      finalPath: '/d/missing',
    })
    const persistTaskWithOccurrence = vi.fn(async () => {})
    const dispatch = vi.fn(async () => {})
    const deps = makeDeps({
      taskManager: {
        getAll: vi.fn(() => [task]),
        persist: vi.fn(async () => {}),
      },
      // Neither diskPath nor finalPath exists → fsState 'neither' → MarkError.
      fs: makeFs(new Set()),
      persistTaskWithOccurrence,
      occurrenceDispatcher: { dispatch },
    })

    const report = await new TaskRecoveryServiceImpl(deps).recoverOnStartup()

    expect(report.errors[0]?.action).toBe(RecoveryAction.MarkError)
    expect(persistTaskWithOccurrence).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: 'recovery-error',
        status: TaskStatus.Error,
      }),
      expect.objectContaining({
        type: 'terminal',
        taskId: 'recovery-error',
        fromStatus: TaskStatus.Downloading,
        toStatus: TaskStatus.Error,
        cause: 'recovery',
      })
    )
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'recovery' })
    )
    // The diagnostic upgrade that sets errorDetailKey dispatches its own
    // (cause-less) diagnosis occurrence through the same dispatcher.
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'diagnosis',
        taskId: 'recovery-error',
      })
    )
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('fires the filesystem-mismatch error hook for a preserved output conflict', async () => {
    const orchestrator = {
      runParallel: vi.fn(async () => {}),
      runBeforeCreateHttp: vi.fn(),
      runBeforeFinalize: vi.fn(),
    } as unknown as RecoveryDeps['orchestrator']
    const task = makeTask({
      id: 'both-paths-hook',
      type: TaskType.Http,
    })
    const deps = makeDeps({
      taskManager: {
        getAll: vi.fn(() => [task]),
        persist: vi.fn(async () => {}),
      },
      fs: makeFs(new Set(['/d/foo.motrix', '/d/foo'])),
      orchestrator,
    })

    await new TaskRecoveryServiceImpl(deps).recoverOnStartup()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(orchestrator?.runParallel).toHaveBeenCalledWith(
      'onError',
      expect.objectContaining({
        error: expect.objectContaining({
          code: ErrorCode.TaskRecoveryFsMismatch,
        }),
      }),
      'both-paths-hook'
    )
  })

  it('recovers a pending media rename without routing through aria2 finalization', async () => {
    const task = makeTask({
      id: 'media-rename',
      kind: TaskKind.Mux,
      type: TaskType.Http,
      transitionPhase: TransitionPhase.Renaming,
      diskPath: '/d/video.mp4.motrix',
      finalPath: '/d/video.mp4',
    })
    const fs = makeFs(new Set(['/d/video.mp4.motrix']))
    const persist = vi.fn(async () => {})
    const deps = makeDeps({
      taskManager: {
        getAll: vi.fn(() => [task]),
        persist,
      },
      fs,
    })
    const recordDownloadCompleted = deps.activityRecorder
      .recordDownloadCompleted as ReturnType<typeof vi.fn>

    await new TaskRecoveryServiceImpl(deps).recoverOnStartup()

    expect(fs.renameAtomic).toHaveBeenCalledWith(
      '/d/video.mp4.motrix',
      '/d/video.mp4'
    )
    expect(deps.finalizeTask).not.toHaveBeenCalled()
    expect(task).toMatchObject({
      status: TaskStatus.Completed,
      diskPath: '/d/video.mp4',
      transitionPhase: TransitionPhase.Idle,
    })
    expect(recordDownloadCompleted).toHaveBeenCalledWith({
      taskId: 'media-rename',
      occurredAt: task.finishedAt,
    })
    expect(
      (fs.renameAtomic as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    ).toBeLessThan(
      recordDownloadCompleted.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY
    )
    expect(recordDownloadCompleted.mock.invocationCallOrder[0]).toBeLessThan(
      persist.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('adopts existing aria2 gid when Reseeding + final_only + infoHash matches', async () => {
    const task = makeTask({
      id: 'bt-2',
      type: TaskType.Bt,
      transitionPhase: TransitionPhase.Reseeding,
      status: TaskStatus.Finalizing,
      diskPath: '/d/bar.motrix',
      finalPath: '/d/bar',
      infoHash: 'abc123',
      engineTaskId: 'old-gid',
    })
    const persist = vi.fn(async () => {})
    const deps = makeDeps({
      taskManager: {
        getAll: vi.fn(() => [task]),
        persist,
      },
      adapter: {
        listActiveAndWaiting: vi.fn(async () => [
          { gid: 'new-gid', infoHash: 'abc123' },
        ]),
      },
      fs: makeFs(new Set(['/d/bar'])),
    })
    const svc = new TaskRecoveryServiceImpl(deps)

    const report = await svc.recoverOnStartup()

    expect(report.totalScanned).toBe(1)
    expect(deps.finalizeTask).not.toHaveBeenCalled()
    expect(task.engineTaskId).toBe('new-gid')
    expect(task.diskPath).toBe('/d/bar')
    expect(
      task.instances.every((instance) => instance.diskPath === '/d/bar')
    ).toBe(true)
    expect(task.transitionPhase).toBe(TransitionPhase.Idle)
    expect(task.status).toBe(TaskStatus.Seeding)
    expect(persist).toHaveBeenCalledWith(task)
    expect(deps.activityRecorder.recordDownloadCompleted).toHaveBeenCalledWith({
      taskId: 'bt-2',
      occurredAt: expect.any(Number),
      accuracy: TaskActivityAccuracy.Recovered,
    })
    expect(deps.recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'bt-2',
        previousStatus: TaskStatus.Finalizing,
        nextStatus: TaskStatus.Seeding,
        accuracy: 'recovered',
      })
    )
    expect(persist.mock.invocationCallOrder[0]).toBeLessThan(
      (deps.recordTransition as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
    expect(report.warnings).toHaveLength(1)
    expect(report.warnings[0]?.action).toBe(RecoveryAction.AdoptExistingGid)
  })

  it('does not adopt a live gid owned by another task with the same infoHash', async () => {
    const recovering = makeTask({
      id: 'same-hash-recovering',
      type: TaskType.Bt,
      transitionPhase: TransitionPhase.Reseeding,
      status: TaskStatus.Finalizing,
      diskPath: '/d/a',
      finalPath: '/d/a',
      infoHash: 'duplicate-hash',
      engineTaskId: 'old-a',
    })
    const owner = makeTask({
      id: 'same-hash-owner',
      type: TaskType.Bt,
      transitionPhase: TransitionPhase.Idle,
      status: TaskStatus.Seeding,
      diskPath: '/d/b',
      finalPath: '/d/b',
      infoHash: 'duplicate-hash',
      engineTaskId: 'live-b',
      instances: [
        {
          ...makeTask().instances[0],
          instanceId: 'owner-primary',
          motrixId: 'same-hash-owner',
          gid: 'live-b',
          diskPath: '/d/b',
        },
      ],
    })
    const finalize = vi.fn(async () => {})
    const deps = makeDeps({
      taskManager: {
        getAll: vi.fn(() => [recovering, owner]),
        persist: vi.fn(async () => {}),
      },
      adapter: {
        listActiveAndWaiting: vi.fn(async () => [
          { gid: 'live-b', infoHash: 'duplicate-hash' },
        ]),
      },
      fs: makeFs(new Set(['/d/a', '/d/b'])),
      finalizeTask: finalize,
    })

    const report = await new TaskRecoveryServiceImpl(deps).recoverOnStartup()

    expect(recovering.engineTaskId).toBe('old-a')
    expect(owner.engineTaskId).toBe('live-b')
    expect(finalize).toHaveBeenCalledWith('same-hash-recovering')
    expect(report.recovered).toContainEqual({
      taskId: 'same-hash-recovering',
      action: RecoveryAction.ResumeFromReseed,
    })
    expect(report.warnings).toHaveLength(0)
  })

  it('never adopts a stopped result as a live seeding identity', async () => {
    const task = makeTask({
      id: 'stopped-hash',
      type: TaskType.Bt,
      transitionPhase: TransitionPhase.Reseeding,
      status: TaskStatus.Finalizing,
      diskPath: '/d/stopped',
      finalPath: '/d/stopped',
      infoHash: 'stopped-only-hash',
      engineTaskId: 'old-stopped',
    })
    const listStopped = vi.fn(async () => [
      { gid: 'stopped-result', infoHash: 'stopped-only-hash' },
    ])
    const finalize = vi.fn(async () => {})
    const deps = makeDeps({
      taskManager: {
        getAll: vi.fn(() => [task]),
        persist: vi.fn(async () => {}),
      },
      adapter: {
        listActiveAndWaiting: vi.fn(async () => []),
        listStopped,
      } as unknown as RecoveryDeps['adapter'],
      fs: makeFs(new Set(['/d/stopped'])),
      finalizeTask: finalize,
    })

    const report = await new TaskRecoveryServiceImpl(deps).recoverOnStartup()

    expect(listStopped).not.toHaveBeenCalled()
    expect(task.engineTaskId).toBe('old-stopped')
    expect(finalize).toHaveBeenCalledWith('stopped-hash')
    expect(report.recovered[0]?.action).toBe(RecoveryAction.ResumeFromReseed)
  })

  it('marks MarkError when files are missing and persists Error status', async () => {
    const task = makeTask({
      id: 'missing-1',
      transitionPhase: TransitionPhase.Renaming,
      diskPath: '/d/gone.motrix',
      finalPath: '/d/gone',
    })
    const persist = vi.fn(async () => {})
    const deps = makeDeps({
      taskManager: {
        getAll: vi.fn(() => [task]),
        persist,
      },
      fs: makeFs(new Set()),
    })
    const svc = new TaskRecoveryServiceImpl(deps)

    const report = await svc.recoverOnStartup()

    expect(task.status).toBe(TaskStatus.Error)
    expect(task.transitionPhase).toBe(TransitionPhase.Idle)
    expect(task.errorDetailKey).toBe('task.error.detail.filesMissing')
    expect(task.errorMessage).toBeNull()
    expect(persist).toHaveBeenCalledWith(task)
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]?.action).toBe(RecoveryAction.MarkError)
    expect(deps.activityRecorder.recordDownloadCompleted).not.toHaveBeenCalled()
  })

  it('republishes the upgraded diagnosis so a later save cannot revert it', async () => {
    const task = makeTask({
      id: 'missing-published',
      transitionPhase: TransitionPhase.Renaming,
      diskPath: '/d/gone.motrix',
      finalPath: '/d/gone',
    })
    const published = new Map<string, DownloadTask>()
    const deps = makeDeps({
      taskManager: {
        getAll: vi.fn(() => [task]),
        set: vi.fn((id: string, next: DownloadTask) => {
          published.set(id, next)
        }),
        persist: vi.fn(async () => {}),
      },
      persistTaskWithOccurrence: vi.fn(async () => {}),
      fs: makeFs(new Set()),
    })

    await new TaskRecoveryServiceImpl(deps).recoverOnStartup()

    // What TaskManager holds is what SessionManager's next buildTaskPayload
    // reads, so the upgraded group has to be the published one — the
    // pre-upgrade clone would write errorDetailKey back to null at
    // diagnosis revision 0.
    const latest = published.get('missing-published')
    expect(latest?.status).toBe(TaskStatus.Error)
    expect(latest?.errorDetailKey).toBe('task.error.detail.filesMissing')
    expect(latest?.diagnosisRevision).toBe(1)
  })

  it('logs a warning and keeps the existing diagnosis on a revision conflict', async () => {
    const task = makeTask({
      id: 'missing-conflict',
      transitionPhase: TransitionPhase.Renaming,
      diskPath: '/d/gone.motrix',
      finalPath: '/d/gone',
    })
    const deps = makeDeps({
      taskManager: {
        getAll: vi.fn(() => [task]),
        persist: vi.fn(async () => {}),
      },
      fs: makeFs(new Set()),
      db: { applyDiagnosisUpgradeRow: vi.fn(() => 'conflict' as const) },
    })
    const svc = new TaskRecoveryServiceImpl(deps)

    await svc.recoverOnStartup()

    expect(task.status).toBe(TaskStatus.Error)
    // The CAS write reported 0 changed rows: the in-memory task keeps
    // whatever error group it already had going in (null here — this task
    // was never in Error before), it is NOT force-overwritten.
    expect(task.errorDetailKey).toBeNull()
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'missing-conflict',
        reason: 'revision-conflict',
      }),
      'recovery diagnostic upgrade skipped'
    )
  })

  it('marks an already-renamed HTTP output completed with recovered accuracy and canonical paths', async () => {
    const task = makeTask({
      id: 'http-recovered',
      type: TaskType.Http,
      transitionPhase: TransitionPhase.Renaming,
      diskPath: '/d/file.zip.motrix',
      finalPath: '/d/file.zip',
    })
    const persist = vi.fn(async () => {})
    const deps = makeDeps({
      taskManager: {
        getAll: vi.fn(() => [task]),
        persist,
      },
      fs: makeFs(new Set(['/d/file.zip'])),
    })
    const recordDownloadCompleted = deps.activityRecorder
      .recordDownloadCompleted as ReturnType<typeof vi.fn>

    await new TaskRecoveryServiceImpl(deps).recoverOnStartup()

    expect(task).toMatchObject({
      status: TaskStatus.Completed,
      diskPath: '/d/file.zip',
      transitionPhase: TransitionPhase.Idle,
    })
    expect(
      task.instances.every(
        (instance) =>
          instance.diskPath === '/d/file.zip' &&
          instance.status === TaskStatus.Completed
      )
    ).toBe(true)
    expect(recordDownloadCompleted).toHaveBeenCalledWith({
      taskId: 'http-recovered',
      occurredAt: task.finishedAt,
      accuracy: TaskActivityAccuracy.Recovered,
    })
    expect(recordDownloadCompleted.mock.invocationCallOrder[0]).toBeLessThan(
      persist.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('does not publish recovered completion when its durable barrier fails', async () => {
    const task = makeTask({
      id: 'http-recovery-barrier',
      type: TaskType.Http,
      transitionPhase: TransitionPhase.Renaming,
      diskPath: '/d/barrier.zip.motrix',
      finalPath: '/d/barrier.zip',
    })
    const set = vi.fn()
    const deps = makeDeps({
      taskManager: {
        getAll: vi.fn(() => [task]),
        set,
        persist: vi.fn(async () => {
          throw new Error('database busy')
        }),
      },
      fs: makeFs(new Set(['/d/barrier.zip'])),
    })

    const report = await new TaskRecoveryServiceImpl(deps).recoverOnStartup()

    expect(task).toMatchObject({
      status: TaskStatus.Finalizing,
      diskPath: '/d/barrier.zip.motrix',
      transitionPhase: TransitionPhase.Renaming,
    })
    expect(set).not.toHaveBeenCalled()
    expect(deps.recordTransition).not.toHaveBeenCalled()
    expect(report.errors).toContainEqual(
      expect.objectContaining({
        taskId: 'http-recovery-barrier',
        issue: 'database busy',
      })
    )
  })
})

describe('TaskRecoveryService plugin-hook chain (Plan C / T15)', () => {
  function makeOrchestrator(): RecoveryDeps['orchestrator'] {
    return {
      runParallel: vi.fn(async () => {}),
      runBeforeCreateHttp: vi.fn(),
      runBeforeFinalize: vi.fn(),
    } as unknown as RecoveryDeps['orchestrator']
  }

  it('MarkCompleted (HTTP final_only + Renaming) fires afterComplete', async () => {
    const orchestrator = makeOrchestrator()
    const task = makeTask({
      id: 'http-done',
      type: TaskType.Http,
      transitionPhase: TransitionPhase.Renaming,
      diskPath: '/d/foo.mp4.motrix',
      finalPath: '/d/foo.mp4',
    })
    const deps = makeDeps({
      taskManager: {
        getAll: vi.fn(() => [task]),
        persist: vi.fn(async () => {}),
      },
      fs: makeFs(new Set(['/d/foo.mp4'])),
      orchestrator,
    })
    const svc = new TaskRecoveryServiceImpl(deps)

    await svc.recoverOnStartup()
    // Give the void promise a microtask to flush.
    await new Promise((r) => setTimeout(r, 0))

    expect(task.status).toBe(TaskStatus.Completed)
    expect(task.finishedAt).not.toBeNull()
    expect(orchestrator?.runParallel).toHaveBeenCalledWith(
      'afterComplete',
      expect.objectContaining({ filePath: '/d/foo.mp4' }),
      'http-done'
    )
  })

  it('MarkError fires onError with files-missing error code', async () => {
    const orchestrator = makeOrchestrator()
    const task = makeTask({
      id: 'gone-1',
      transitionPhase: TransitionPhase.Renaming,
      diskPath: '/d/gone.motrix',
      finalPath: '/d/gone',
    })
    const deps = makeDeps({
      taskManager: {
        getAll: vi.fn(() => [task]),
        persist: vi.fn(async () => {}),
      },
      fs: makeFs(new Set()),
      orchestrator,
    })
    const svc = new TaskRecoveryServiceImpl(deps)

    await svc.recoverOnStartup()
    await new Promise((r) => setTimeout(r, 0))

    expect(task.status).toBe(TaskStatus.Error)
    expect(task.finishedAt).not.toBeNull()
    expect(orchestrator?.runParallel).toHaveBeenCalledWith(
      'onError',
      expect.objectContaining({
        error: expect.objectContaining({ code: 'RECOVERY_FILES_MISSING' }),
      }),
      'gone-1'
    )
  })

  it('parallel hook failure is isolated (does not break the recovery loop)', async () => {
    const orchestrator = {
      runParallel: vi.fn().mockRejectedValue(new Error('plugin sad')),
      runBeforeCreateHttp: vi.fn(),
      runBeforeFinalize: vi.fn(),
    } as unknown as RecoveryDeps['orchestrator']
    const task = makeTask({
      id: 'gone-2',
      transitionPhase: TransitionPhase.Renaming,
      diskPath: '/d/gone.motrix',
      finalPath: '/d/gone',
    })
    const deps = makeDeps({
      taskManager: {
        getAll: vi.fn(() => [task]),
        persist: vi.fn(async () => {}),
      },
      fs: makeFs(new Set()),
      orchestrator,
    })
    const svc = new TaskRecoveryServiceImpl(deps)

    await expect(svc.recoverOnStartup()).resolves.toBeDefined()
    await new Promise((r) => setTimeout(r, 0))
    expect(task.status).toBe(TaskStatus.Error)
  })

  it('absent orchestrator is a no-op (backward compat)', async () => {
    const task = makeTask({
      id: 'no-orch',
      transitionPhase: TransitionPhase.Renaming,
      diskPath: '/d/missing.motrix',
      finalPath: '/d/missing',
    })
    const deps = makeDeps({
      taskManager: {
        getAll: vi.fn(() => [task]),
        persist: vi.fn(async () => {}),
      },
      fs: makeFs(new Set()),
      // no orchestrator
    })
    const svc = new TaskRecoveryServiceImpl(deps)
    await expect(svc.recoverOnStartup()).resolves.toBeDefined()
    expect(task.status).toBe(TaskStatus.Error)
  })
})
