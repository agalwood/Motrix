import { Events } from '@shared/protocol/events'
import { type DownloadTask, TaskKind, TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { directTaskUpdatePublication } from '@test-utils/task-update'
import { describe, expect, it, vi } from 'vitest'
import type { EngineAdapter } from '../../engine/engine-adapter'
import type { EventBus } from '../../events/event-bus'
import type { Logger } from '../../logger'
import type { TaskManager } from '../task-manager'
import { pauseTask } from './pause-task'

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
          status: TaskStatus.Downloading,
        })
  const allTasks = task ? [task] : []
  const base = {
    taskManager: {
      getById: vi.fn().mockReturnValue(task),
      set: vi.fn(),
      getAll: vi.fn().mockReturnValue(allTasks),
    } as unknown as TaskManager,
    adapter: {
      pauseTask: vi.fn().mockResolvedValue(undefined),
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

describe('pauseTask', () => {
  it('looks up engineTaskId and calls adapter.pauseTask with gid', async () => {
    const deps = makeDeps()
    await pauseTask('t1', deps)
    expect(deps.taskManager.getById).toHaveBeenCalledWith('t1')
    expect(deps.adapter.pauseTask).toHaveBeenCalledWith('gid-1')
    expect(deps.adapter.pauseTask).toHaveBeenCalledOnce()
  })

  it('optimistically updates task status to Paused after RPC success', async () => {
    const deps = makeDeps()
    await pauseTask('t1', deps)
    expect(deps.taskManager.set).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({
        status: TaskStatus.Paused,
        downloadSpeed: 0,
        uploadSpeed: 0,
        etaSeconds: 0,
      })
    )
  })

  it('emits TaskUpdated event after the optimistic update', async () => {
    const deps = makeDeps()
    await pauseTask('t1', deps)
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Array)
    )
  })

  it('records an accepted user pause as an exact transition', async () => {
    const deps = makeDeps()

    await pauseTask('t1', deps)

    expect(deps.recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        previousStatus: TaskStatus.Downloading,
        nextStatus: TaskStatus.Paused,
        accuracy: 'exact',
      })
    )
  })

  it('keeps the accepted pause exact when polling publishes Paused first', async () => {
    const deps = makeDeps()
    const original = deps.taskManager.getById('t1')
    if (!original) throw new Error('test task is missing')
    const observed = { ...original, status: TaskStatus.Paused }
    vi.mocked(deps.taskManager.getById)
      .mockReset()
      .mockReturnValueOnce(original)
      .mockReturnValue(observed)

    await pauseTask('t1', deps)

    expect(deps.recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        previousStatus: TaskStatus.Downloading,
        nextStatus: TaskStatus.Paused,
        accuracy: 'exact',
      })
    )
  })

  it('keeps the accepted pause when the immediate engine status is still stale', async () => {
    const deps = makeDeps()
    ;(
      deps.adapter as unknown as { getTaskStatus: ReturnType<typeof vi.fn> }
    ).getTaskStatus = vi.fn().mockResolvedValue(
      makeDownloadTask({
        id: 't1',
        engineTaskId: 'gid-1',
        status: TaskStatus.Downloading,
        downloadSpeed: 123,
        uploadSpeed: 0,
      })
    )

    await pauseTask('t1', deps)

    expect(deps.taskManager.set).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ status: TaskStatus.Paused })
    )
    expect(deps.recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        previousStatus: TaskStatus.Downloading,
        nextStatus: TaskStatus.Paused,
        accuracy: 'exact',
      })
    )
  })

  it('does not update or emit when adapter rejects', async () => {
    const deps = makeDeps()
    ;(deps.adapter.pauseTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('engine error')
    )
    await expect(pauseTask('t1', deps)).rejects.toThrow('engine error')
    expect(deps.taskManager.set).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).not.toHaveBeenCalled()
  })

  it('does not publish, record, or emit when persistence rejects after RPC success', async () => {
    const deps = makeDeps()
    deps.persistTask.mockRejectedValueOnce(new Error('disk full'))

    await expect(pauseTask('t1', deps)).rejects.toThrow('disk full')

    expect(deps.taskManager.set).not.toHaveBeenCalled()
    expect(deps.recordTransition).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).not.toHaveBeenCalled()
  })

  it('reconciles current engine status when adapter rejects after stale UI action', async () => {
    const deps = makeDeps()
    ;(deps.adapter.pauseTask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('cannot be paused now')
    )
    ;(
      deps.adapter as unknown as { getTaskStatus: ReturnType<typeof vi.fn> }
    ).getTaskStatus = vi.fn().mockResolvedValue({
      id: 'gid-1',
      engineTaskId: 'gid-1',
      status: TaskStatus.Downloading,
      downloadSpeed: 123,
      uploadSpeed: 0,
      etaSeconds: 10,
      progress: 0.5,
      totalBytes: 100,
      sizeWhenDone: 100,
      downloadedBytes: 50,
      connections: 1,
      uploadedBytes: 0,
      uploadedBytesBaseline: 0,
      fileCount: 1,
      errorMessage: null,
      finishedAt: null,
      infoHash: null,
      uris: [],
    })

    await expect(pauseTask('t1', deps)).rejects.toThrow('cannot be paused now')

    expect(deps.taskManager.set).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({
        status: TaskStatus.Downloading,
        downloadSpeed: 123,
      })
    )
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Array)
    )
  })

  it('warns and no-ops when task not found', async () => {
    const deps = makeDeps({ task: undefined })
    await pauseTask('missing', deps)
    expect(deps.adapter.pauseTask).not.toHaveBeenCalled()
    expect(deps.taskManager.set).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).not.toHaveBeenCalled()
    expect(deps.log.warn).toHaveBeenCalledWith(
      { taskId: 'missing' },
      'pauseTask: task not found'
    )
  })

  // Bug B: a coordinator-managed media task has engineTaskId === '' — pausing
  // must act on the real segment gids, never on the empty engine handle.
  it('pauses the active segment gids for a media task (never the empty gid)', async () => {
    const deps = makeDeps({
      task: {
        id: 'm1',
        engineTaskId: '',
        status: TaskStatus.Downloading,
        kind: TaskKind.Mux,
      },
      mediaGids: ['seg-a', 'seg-b'],
    })

    await pauseTask('m1', deps)

    expect(deps.adapter.pauseTask).toHaveBeenCalledWith('seg-a')
    expect(deps.adapter.pauseTask).toHaveBeenCalledWith('seg-b')
    expect(deps.adapter.pauseTask).not.toHaveBeenCalledWith('')
    expect(deps.taskManager.set).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ status: TaskStatus.Paused })
    )
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Array)
    )
  })

  it('uses the same durable commit for coordinator-managed media tasks', async () => {
    const deps = makeDeps({
      task: {
        id: 'm1',
        engineTaskId: '',
        status: TaskStatus.Downloading,
        kind: TaskKind.Mux,
      },
      mediaGids: ['seg-a'],
    })
    deps.persistTask.mockRejectedValueOnce(new Error('disk full'))

    await expect(pauseTask('m1', deps)).rejects.toThrow('disk full')
    expect(deps.taskManager.set).not.toHaveBeenCalled()
    expect(deps.recordTransition).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).not.toHaveBeenCalled()
  })

  it('no-ops (no adapter call, no throw, no state change) when a media task has no active segments', async () => {
    const deps = makeDeps({
      task: {
        id: 'm2',
        engineTaskId: '',
        status: TaskStatus.Downloading,
        kind: TaskKind.Hls,
      },
      mediaGids: [],
    })

    // No active segment gids (mux phase, or the brief pre-addUri window): must
    // NOT crash with aria2's "Invalid GID" AND must not surface a spurious
    // error — silently ignore so a stray click while muxing is harmless.
    await expect(pauseTask('m2', deps)).resolves.toBeUndefined()
    expect(deps.adapter.pauseTask).not.toHaveBeenCalled()
    expect(deps.taskManager.set).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).not.toHaveBeenCalled()
  })
})
