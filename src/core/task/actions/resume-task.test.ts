import { Events } from '@shared/protocol/events'
import { type DownloadTask, TaskKind, TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { directTaskUpdatePublication } from '@test-utils/task-update'
import { describe, expect, it, vi } from 'vitest'
import type { EngineAdapter } from '../../engine/engine-adapter'
import type { EventBus } from '../../events/event-bus'
import type { Logger } from '../../logger'
import type { TaskManager } from '../task-manager'
import { resumeTask } from './resume-task'

function makeDeps(
  overrides: Partial<{
    task:
      | (Partial<DownloadTask> & Pick<DownloadTask, 'id' | 'engineTaskId'>)
      | undefined
    mediaGids: string[]
  }> = {}
) {
  const task =
    'task' in overrides
      ? overrides.task
        ? makeDownloadTask(overrides.task)
        : undefined
      : makeDownloadTask({
          id: 't1',
          engineTaskId: 'gid-1',
          status: TaskStatus.Paused,
        })
  const allTasks = task ? [task] : []
  const base = {
    taskManager: {
      getById: vi.fn().mockReturnValue(task),
      set: vi.fn(),
      getAll: vi.fn().mockReturnValue(allTasks),
    } as unknown as TaskManager,
    adapter: {
      resumeTask: vi.fn().mockResolvedValue(undefined),
    } as unknown as EngineAdapter,
    eventBus: {
      emit: vi.fn(),
    } as unknown as EventBus,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
    getMediaSegmentGids:
      overrides.mediaGids !== undefined
        ? vi.fn().mockReturnValue(overrides.mediaGids)
        : undefined,
    persistTask: vi.fn().mockResolvedValue(undefined),
    recordTransition: vi.fn().mockResolvedValue(undefined),
  }
  return { ...base, ...directTaskUpdatePublication(base) }
}

describe('resumeTask', () => {
  it('calls adapter.resumeTask with gid', async () => {
    const deps = makeDeps()
    await resumeTask('t1', deps)
    expect(deps.adapter.resumeTask).toHaveBeenCalledWith('gid-1')
  })

  it('optimistically updates task status to Downloading after RPC success', async () => {
    const deps = makeDeps()
    await resumeTask('t1', deps)
    expect(deps.taskManager.set).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({
        status: TaskStatus.Downloading,
      })
    )
  })

  it('emits TaskUpdated event after the optimistic update', async () => {
    const deps = makeDeps()
    await resumeTask('t1', deps)
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Array)
    )
  })

  it('records an accepted user resume as an exact transition', async () => {
    const deps = makeDeps()

    await resumeTask('t1', deps)

    expect(deps.recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        previousStatus: TaskStatus.Paused,
        nextStatus: TaskStatus.Downloading,
        accuracy: 'exact',
      })
    )
  })

  it('keeps the accepted resume exact when polling publishes Downloading first', async () => {
    const deps = makeDeps()
    const original = deps.taskManager.getById('t1')
    if (!original) throw new Error('test task is missing')
    const observed = { ...original, status: TaskStatus.Downloading }
    vi.mocked(deps.taskManager.getById)
      .mockReset()
      .mockReturnValueOnce(original)
      .mockReturnValue(observed)

    await resumeTask('t1', deps)

    expect(deps.recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        previousStatus: TaskStatus.Paused,
        nextStatus: TaskStatus.Downloading,
        accuracy: 'exact',
      })
    )
  })

  it('keeps the accepted resume when the immediate engine status is still stale', async () => {
    const deps = makeDeps()
    ;(
      deps.adapter as unknown as { getTaskStatus: ReturnType<typeof vi.fn> }
    ).getTaskStatus = vi.fn().mockResolvedValue(
      makeDownloadTask({
        id: 't1',
        engineTaskId: 'gid-1',
        status: TaskStatus.Paused,
        downloadSpeed: 0,
        uploadSpeed: 0,
      })
    )

    await resumeTask('t1', deps)

    expect(deps.taskManager.set).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ status: TaskStatus.Downloading })
    )
    expect(deps.recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        previousStatus: TaskStatus.Paused,
        nextStatus: TaskStatus.Downloading,
        accuracy: 'exact',
      })
    )
  })

  it('keeps an authoritative non-source status after the accepted resume', async () => {
    const deps = makeDeps()
    ;(
      deps.adapter as unknown as { getTaskStatus: ReturnType<typeof vi.fn> }
    ).getTaskStatus = vi.fn().mockResolvedValue(
      makeDownloadTask({
        id: 't1',
        engineTaskId: 'gid-1',
        status: TaskStatus.Queued,
      })
    )

    await resumeTask('t1', deps)

    expect(deps.taskManager.set).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ status: TaskStatus.Queued })
    )
    expect(deps.recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        previousStatus: TaskStatus.Paused,
        nextStatus: TaskStatus.Queued,
        accuracy: 'exact',
      })
    )
  })

  it('does not update or emit when adapter rejects', async () => {
    const deps = makeDeps()
    ;(
      deps.adapter.resumeTask as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error('cannot be unpaused now'))
    await expect(resumeTask('t1', deps)).rejects.toThrow(
      'cannot be unpaused now'
    )
    expect(deps.taskManager.set).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).not.toHaveBeenCalled()
  })

  it('does not publish, record, or emit when persistence rejects after RPC success', async () => {
    const deps = makeDeps()
    deps.persistTask.mockRejectedValueOnce(new Error('disk full'))

    await expect(resumeTask('t1', deps)).rejects.toThrow('disk full')

    expect(deps.taskManager.set).not.toHaveBeenCalled()
    expect(deps.recordTransition).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).not.toHaveBeenCalled()
  })

  it('treats adapter rejection as success when engine is already resumed', async () => {
    const deps = makeDeps()
    ;(
      deps.adapter.resumeTask as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error('cannot be unpaused now'))
    ;(
      deps.adapter as unknown as { getTaskStatus: ReturnType<typeof vi.fn> }
    ).getTaskStatus = vi.fn().mockResolvedValue({
      id: 'gid-1',
      engineTaskId: 'gid-1',
      status: TaskStatus.Downloading,
      downloadSpeed: 456,
      uploadSpeed: 0,
      etaSeconds: 8,
      progress: 0.7,
      totalBytes: 100,
      sizeWhenDone: 100,
      downloadedBytes: 70,
      connections: 2,
      uploadedBytes: 0,
      uploadedBytesBaseline: 0,
      fileCount: 1,
      errorMessage: null,
      finishedAt: null,
      infoHash: null,
      uris: [],
    })

    await expect(resumeTask('t1', deps)).resolves.toBeUndefined()

    expect(deps.taskManager.set).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({
        status: TaskStatus.Downloading,
        downloadSpeed: 456,
      })
    )
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Array)
    )
  })

  it('still rejects when adapter rejects and engine remains paused', async () => {
    const deps = makeDeps()
    ;(
      deps.adapter.resumeTask as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error('cannot be unpaused now'))
    ;(
      deps.adapter as unknown as { getTaskStatus: ReturnType<typeof vi.fn> }
    ).getTaskStatus = vi.fn().mockResolvedValue({
      id: 'gid-1',
      engineTaskId: 'gid-1',
      status: TaskStatus.Paused,
      downloadSpeed: 0,
      uploadSpeed: 0,
      etaSeconds: 0,
      progress: 0.7,
      totalBytes: 100,
      sizeWhenDone: 100,
      downloadedBytes: 70,
      connections: 0,
      uploadedBytes: 0,
      uploadedBytesBaseline: 0,
      fileCount: 1,
      errorMessage: null,
      finishedAt: null,
      infoHash: null,
      uris: [],
    })

    await expect(resumeTask('t1', deps)).rejects.toThrow(
      'cannot be unpaused now'
    )
  })

  it('keeps optimistic Downloading when immediate post-resume sync returns transient Error', async () => {
    const deps = makeDeps()
    ;(
      deps.adapter as unknown as { getTaskStatus: ReturnType<typeof vi.fn> }
    ).getTaskStatus = vi.fn().mockResolvedValue({
      id: 'gid-1',
      engineTaskId: 'gid-1',
      status: TaskStatus.Error,
      downloadSpeed: 0,
      uploadSpeed: 0,
      etaSeconds: 0,
      progress: 0.7,
      totalBytes: 100,
      sizeWhenDone: 100,
      downloadedBytes: 70,
      connections: 0,
      uploadedBytes: 0,
      uploadedBytesBaseline: 0,
      fileCount: 1,
      errorMessage: 'transient stale result',
      finishedAt: null,
      infoHash: null,
      uris: [],
    })

    await resumeTask('t1', deps)

    expect(deps.taskManager.set).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({
        status: TaskStatus.Downloading,
      })
    )
  })

  it('warns when task not found', async () => {
    const deps = makeDeps({ task: undefined })
    await resumeTask('missing', deps)
    expect(deps.adapter.resumeTask).not.toHaveBeenCalled()
    expect(deps.taskManager.set).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).not.toHaveBeenCalled()
    expect(deps.log.warn).toHaveBeenCalled()
  })

  // Bug B: resume the real segment gids for a coordinator-managed media task.
  it('resumes the active segment gids for a media task (never the empty gid)', async () => {
    const deps = makeDeps({
      task: {
        id: 'm1',
        engineTaskId: '',
        status: TaskStatus.Paused,
        kind: TaskKind.Mux,
      },
      mediaGids: ['seg-a', 'seg-b'],
    })

    await resumeTask('m1', deps)

    expect(deps.adapter.resumeTask).toHaveBeenCalledWith('seg-a')
    expect(deps.adapter.resumeTask).toHaveBeenCalledWith('seg-b')
    expect(deps.adapter.resumeTask).not.toHaveBeenCalledWith('')
    expect(deps.taskManager.set).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ status: TaskStatus.Downloading })
    )
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Array)
    )
  })

  it('no-ops (no adapter call, no throw, no state change) when a media task has no active segments', async () => {
    const deps = makeDeps({
      task: {
        id: 'm2',
        engineTaskId: '',
        status: TaskStatus.Paused,
        kind: TaskKind.Hls,
      },
      mediaGids: [],
    })

    await expect(resumeTask('m2', deps)).resolves.toBeUndefined()
    expect(deps.adapter.resumeTask).not.toHaveBeenCalled()
    expect(deps.taskManager.set).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).not.toHaveBeenCalled()
  })
})
