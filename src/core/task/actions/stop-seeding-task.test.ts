import { Events } from '@shared/protocol/events'
import { TaskStatus, TaskType } from '@shared/types/task'
import { directTaskUpdatePublication } from '@test-utils/task-update'
import { describe, expect, it, vi } from 'vitest'
import type { EngineAdapter } from '../../engine/engine-adapter'
import type { EventBus } from '../../events/event-bus'
import type { Logger } from '../../logger'
import type { TaskManager } from '../task-manager'
import { stopSeedingTask } from './stop-seeding-task'

function makeDeps(
  overrides: Partial<{
    task:
      | {
          id: string
          engineTaskId: string
          status: TaskStatus
          type?: TaskType
        }
      | undefined
  }> = {}
) {
  const task =
    'task' in overrides
      ? overrides.task
      : {
          id: 't1',
          engineTaskId: 'gid-1',
          status: TaskStatus.Seeding,
          type: TaskType.Bt,
        }
  const allTasks = task ? [task] : []
  const base = {
    taskManager: {
      getById: vi.fn().mockReturnValue(task),
      set: vi.fn(),
      getAll: vi.fn().mockReturnValue(allTasks),
    } as unknown as TaskManager,
    adapter: {
      forceRemoveTask: vi.fn().mockResolvedValue(undefined),
      getTaskStatus: vi.fn().mockResolvedValue(null),
    } as unknown as EngineAdapter,
    eventBus: {
      emit: vi.fn(),
    } as unknown as EventBus,
    persist: vi.fn().mockResolvedValue(undefined),
    recordTransition: vi.fn().mockResolvedValue(undefined),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
  }
  return { ...base, ...directTaskUpdatePublication(base) }
}

describe('stopSeedingTask', () => {
  it('calls adapter.forceRemoveTask with the engine gid', async () => {
    const deps = makeDeps()
    await stopSeedingTask('t1', deps)
    expect(deps.adapter.forceRemoveTask).toHaveBeenCalledWith('gid-1')
  })

  it('optimistically sets status to Completed with finishedAt', async () => {
    const deps = makeDeps()
    await stopSeedingTask('t1', deps)
    expect(deps.taskManager.set).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({
        status: TaskStatus.Completed,
        finishedAt: expect.any(Number),
        downloadSpeed: 0,
        uploadSpeed: 0,
        etaSeconds: 0,
      })
    )
    expect(deps.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        status: TaskStatus.Completed,
        finishedAt: expect.any(Number),
      })
    )
  })

  it('persists Completed before emitting TaskUpdated', async () => {
    const deps = makeDeps()
    await stopSeedingTask('t1', deps)
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.any(Array)
    )
    expect(deps.persist.mock.invocationCallOrder[0]).toBeLessThan(
      (deps.eventBus.emit as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0]
    )
    expect(deps.persist.mock.invocationCallOrder[0]).toBeLessThan(
      (deps.taskManager.set as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0]
    )
    expect(
      (deps.taskManager.set as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0]
    ).toBeLessThan(deps.recordTransition.mock.invocationCallOrder[0])
  })

  it('keeps optimistic Completed when aria2 reports the removed result', async () => {
    const deps = makeDeps()
    ;(
      deps.adapter.getTaskStatus as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      status: TaskStatus.Removed,
    })

    await stopSeedingTask('t1', deps)

    expect(deps.adapter.getTaskStatus).not.toHaveBeenCalled()
    expect(deps.taskManager.set).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({
        status: TaskStatus.Completed,
        finishedAt: expect.any(Number),
      })
    )
    expect(deps.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        status: TaskStatus.Completed,
        finishedAt: expect.any(Number),
      })
    )
    expect(deps.persist).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: TaskStatus.Removed })
    )
  })

  it('does not let a stale Seeding snapshot overwrite Completed', async () => {
    const deps = makeDeps()
    ;(
      deps.adapter.getTaskStatus as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      status: TaskStatus.Seeding,
    })

    await stopSeedingTask('t1', deps)

    expect(deps.adapter.getTaskStatus).not.toHaveBeenCalled()
    expect(deps.taskManager.set).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ status: TaskStatus.Completed })
    )
    expect(deps.persist).toHaveBeenCalledWith(
      expect.objectContaining({ status: TaskStatus.Completed })
    )
  })

  it('warns and no-ops when task is missing', async () => {
    const deps = makeDeps({ task: undefined })
    await stopSeedingTask('missing', deps)
    expect(deps.adapter.forceRemoveTask).not.toHaveBeenCalled()
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'missing' }),
      'stopSeedingTask: task not found'
    )
  })

  it('warns and no-ops when task is not Seeding', async () => {
    const deps = makeDeps({
      task: {
        id: 't1',
        engineTaskId: 'gid-1',
        status: TaskStatus.Downloading,
        type: TaskType.Bt,
      },
    })
    await stopSeedingTask('t1', deps)
    expect(deps.adapter.forceRemoveTask).not.toHaveBeenCalled()
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't1', status: TaskStatus.Downloading }),
      'stopSeedingTask: task is not Seeding'
    )
  })

  // "Already evicted" (aria2 "is not found") is now absorbed by
  // Aria2Adapter.forceRemoveTask, so stopSeedingTask sees a resolved call and
  // completes — covered by the "optimistically sets Completed" test above. The
  // adapter's not-found absorption is covered in aria2-adapter.test.ts.
  it('rethrows other engine errors and reverts optimistic state', async () => {
    const deps = makeDeps()
    ;(
      deps.adapter.forceRemoveTask as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error('rpc timeout'))
    await expect(stopSeedingTask('t1', deps)).rejects.toThrow('rpc timeout')
    expect(deps.persist).not.toHaveBeenCalled()
  })

  it('rejects a persistence failure and does not emit a false success update', async () => {
    const deps = makeDeps()
    deps.persist.mockRejectedValueOnce(new Error('db locked'))

    await expect(stopSeedingTask('t1', deps)).rejects.toThrow('db locked')

    expect(deps.taskManager.set).not.toHaveBeenCalled()
    expect(deps.recordTransition).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).not.toHaveBeenCalled()
  })

  it('writes the Seeding->Completed occurrence with cause "engine" and dispatches it', async () => {
    const deps = makeDeps()
    const persistTaskWithOccurrence = vi.fn().mockResolvedValue(undefined)
    const dispatch = vi.fn().mockResolvedValue(undefined)

    await stopSeedingTask('t1', {
      ...deps,
      persistTaskWithOccurrence,
      occurrenceDispatcher: { dispatch },
    } as never)

    expect(persistTaskWithOccurrence).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: TaskStatus.Completed }),
      expect.objectContaining({
        type: 'terminal',
        taskId: 't1',
        fromStatus: TaskStatus.Seeding,
        toStatus: TaskStatus.Completed,
        cause: 'engine',
      })
    )
    // The occurrence path bypasses plain persist entirely.
    expect(deps.persist).not.toHaveBeenCalled()
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cause: 'engine' })
    )
  })
})
