import { DownloadErrorCode } from '@shared/errors'
import { Events } from '@shared/protocol/events'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus, TaskType, TransitionPhase } from '@shared/types/task'
import { terminalOccurrenceId } from '@shared/types/task-occurrence'
import { makeDownloadTask } from '@test-utils/task'
import { directTaskUpdatePublication } from '@test-utils/task-update'
import { describe, expect, it, vi } from 'vitest'
import { dispatchTaskUpdates } from '../../bridge-receiver/progress-mapping'
import { EventBus } from '../../events/event-bus'
import { mergeEngineTask } from '../merge-engine-task'
import { TaskManager } from '../task-manager'
import { TaskUpdatePublisher } from '../task-update-publisher'
import {
  commitPolledTerminalTransition,
  commitTaskUpdate,
  type TaskActionDeps,
} from './shared'

/**
 * commitTaskUpdate now requires the publisher pair. Reuse the synchronous
 * pass-through so every legacy assertion on `deps.eventBus.emit` stays
 * valid; tests that assert the routing itself provide their own fns.
 */
function withDirectPublication<
  T extends {
    eventBus: { emit(channel: string, ...args: unknown[]): void }
    taskManager: { getAll(): unknown[] }
    publishTaskUpdate?: () => void
    publishTaskUpdateNow?: () => void
  },
>(deps: T): T {
  const direct = directTaskUpdatePublication(
    deps as Parameters<typeof directTaskUpdatePublication>[0]
  )
  return {
    ...direct,
    ...deps,
    publishTaskUpdate: deps.publishTaskUpdate ?? direct.publishTaskUpdate,
    publishTaskUpdateNow:
      deps.publishTaskUpdateNow ?? direct.publishTaskUpdateNow,
  }
}

describe('commitTaskUpdate', () => {
  it('crosses the durable barrier before publishing, recording, and emitting', async () => {
    const previous = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Downloading,
    })
    const next = { ...previous, status: TaskStatus.Paused }
    const order: string[] = []
    const deps = {
      taskManager: {
        set: vi.fn(() => order.push('publish')),
        getAll: vi.fn(() => [next]),
      },
      adapter: {},
      eventBus: {
        emit: vi.fn(() => order.push('emit')),
      },
      log: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      persistTask: vi.fn(async () => {
        order.push('persist')
      }),
      recordTransition: vi.fn(async () => {
        order.push('record')
      }),
      now: () => 123,
      monotonicNow: () => 456,
    }

    await commitTaskUpdate(
      previous,
      next,
      withDirectPublication(deps) as unknown as TaskActionDeps
    )

    expect(order).toEqual(['persist', 'publish', 'record', 'emit'])
    expect(deps.recordTransition).toHaveBeenCalledWith({
      taskId: 'task-1',
      previousStatus: TaskStatus.Downloading,
      nextStatus: TaskStatus.Paused,
      occurredAt: 123,
      monotonicAt: 456,
      accuracy: 'exact',
      errorCode: next.errorCode,
      errorMessage: next.errorMessage,
      errorDetailKey: next.errorDetailKey,
      errorDetailParams: next.errorDetailParams,
      // Paused is not terminal, so no occurrence was built for this commit.
      occurrenceId: null,
    })
    expect(deps.eventBus.emit).toHaveBeenCalledWith(Events.TaskUpdated, [next])
  })

  it('threads errorDetailKey/errorDetailParams from the committed task into recordTransition', async () => {
    const previous = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Downloading,
    })
    const next = {
      ...previous,
      status: TaskStatus.Error,
      errorCode: DownloadErrorCode.FileWriteError,
      errorMessage: 'Failed to rename file: EACCES',
      errorDetailKey: 'task.error.detail.renameFileFailed',
      errorDetailParams: { cause: 'EACCES' },
    }
    const deps = {
      taskManager: {
        set: vi.fn(),
        getAll: vi.fn(() => [next]),
      },
      adapter: {},
      eventBus: { emit: vi.fn() },
      log: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      persistTask: vi.fn(async () => {}),
      recordTransition: vi.fn(async () => {}),
    }

    await commitTaskUpdate(
      previous,
      next,
      withDirectPublication(deps) as unknown as TaskActionDeps
    )

    expect(deps.recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        errorDetailKey: 'task.error.detail.renameFileFailed',
        errorDetailParams: { cause: 'EACCES' },
      })
    )
  })

  it('publishes nothing when the durable barrier rejects', async () => {
    const previous = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Downloading,
    })
    const next = { ...previous, status: TaskStatus.Paused }
    const deps = {
      taskManager: {
        set: vi.fn(),
        getAll: vi.fn(() => [previous]),
      },
      adapter: {},
      eventBus: { emit: vi.fn() },
      log: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      persistTask: vi.fn().mockRejectedValue(new Error('disk full')),
      recordTransition: vi.fn(),
    }

    await expect(
      commitTaskUpdate(
        previous,
        next,
        withDirectPublication(deps) as unknown as TaskActionDeps
      )
    ).rejects.toThrow('disk full')

    expect(deps.taskManager.set).not.toHaveBeenCalled()
    expect(deps.recordTransition).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).not.toHaveBeenCalled()
  })

  it('records the accepted transition when polling publishes the same generation first', async () => {
    const previous = makeDownloadTask({
      id: 'task-1',
      engineTaskId: 'gid-1',
      status: TaskStatus.Downloading,
    })
    const next = {
      ...previous,
      status: TaskStatus.Paused,
      downloadSpeed: 0,
    }
    const observed = {
      ...next,
      completedBytes: 512,
    }
    const deps = {
      taskManager: {
        getById: vi.fn(() => observed),
        set: vi.fn(),
        getAll: vi.fn(() => [observed]),
      },
      adapter: {},
      eventBus: { emit: vi.fn() },
      log: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      persistTask: vi.fn().mockResolvedValue(undefined),
      recordTransition: vi.fn().mockResolvedValue(undefined),
      runTaskMutation: vi.fn(
        async (_taskIds: readonly string[], operation: () => Promise<void>) =>
          operation()
      ),
    }

    await commitTaskUpdate(
      previous,
      next,
      withDirectPublication(deps) as unknown as TaskActionDeps,
      {
        transitionFromStatus: TaskStatus.Downloading,
      }
    )

    expect(deps.persistTask).toHaveBeenCalledWith(observed)
    expect(deps.taskManager.set).toHaveBeenCalledWith('task-1', observed)
    expect(deps.recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        previousStatus: TaskStatus.Downloading,
        nextStatus: TaskStatus.Paused,
        accuracy: 'exact',
      })
    )
    expect(deps.eventBus.emit).toHaveBeenCalledWith(Events.TaskUpdated, [
      observed,
    ])
  })

  it('rejects a stale transition after the public task switches engine generation', async () => {
    const previous = makeDownloadTask({
      id: 'task-1',
      engineTaskId: 'gid-old',
      status: TaskStatus.Downloading,
    })
    const next = { ...previous, status: TaskStatus.Paused }
    const replacement = makeDownloadTask({
      id: 'task-1',
      engineTaskId: 'gid-new',
      status: TaskStatus.Paused,
    })
    const deps = {
      taskManager: {
        getById: vi.fn(() => replacement),
        set: vi.fn(),
        getAll: vi.fn(() => [replacement]),
      },
      adapter: {},
      eventBus: { emit: vi.fn() },
      log: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      persistTask: vi.fn().mockResolvedValue(undefined),
      recordTransition: vi.fn().mockResolvedValue(undefined),
      runTaskMutation: vi.fn(
        async (_taskIds: readonly string[], operation: () => Promise<void>) =>
          operation()
      ),
    }

    await commitTaskUpdate(
      previous,
      next,
      withDirectPublication(deps) as unknown as TaskActionDeps
    )

    expect(deps.persistTask).not.toHaveBeenCalled()
    expect(deps.taskManager.set).not.toHaveBeenCalled()
    expect(deps.recordTransition).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).not.toHaveBeenCalled()
  })

  it('commit into Error writes exactly one occurrence row atomically and dispatches it', async () => {
    const previous = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Downloading,
      errorCode: null,
      errorMessage: null,
    })
    const finishedAt = 5000
    const next = {
      ...previous,
      status: TaskStatus.Error,
      finishedAt,
      errorCode: DownloadErrorCode.NetworkError,
      errorMessage: 'connection reset',
    }
    const deps = {
      taskManager: {
        set: vi.fn(),
        getAll: vi.fn(() => [next]),
      },
      adapter: {},
      eventBus: { emit: vi.fn() },
      log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      persistTask: vi.fn(async () => undefined),
      persistTaskWithOccurrence: vi.fn(async () => undefined),
      occurrenceDispatcher: { dispatch: vi.fn(async () => undefined) },
      recordTransition: vi.fn(async () => undefined),
    }

    await commitTaskUpdate(
      previous,
      next,
      withDirectPublication(deps) as unknown as TaskActionDeps
    )

    const expectedOccurrence = {
      occurrenceId: terminalOccurrenceId(
        'task-1',
        TaskStatus.Error,
        finishedAt
      ),
      type: 'terminal',
      taskId: 'task-1',
      fromStatus: TaskStatus.Downloading,
      toStatus: TaskStatus.Error,
      cause: 'engine',
      errorGroup: {
        errorCode: DownloadErrorCode.NetworkError,
        errorMessage: 'connection reset',
        errorDetailKey: null,
        errorDetailParams: null,
      },
      createdAt: finishedAt,
    }
    expect(deps.persistTaskWithOccurrence).toHaveBeenCalledExactlyOnceWith(
      next,
      expectedOccurrence
    )
    expect(deps.persistTask).not.toHaveBeenCalled()
    expect(deps.occurrenceDispatcher.dispatch).toHaveBeenCalledExactlyOnceWith(
      expectedOccurrence
    )
    // The Activity runtime keys the history item off the occurrence id so the
    // outbox consumer recognizes this item instead of appending its own.
    expect(deps.recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        occurrenceId: expectedOccurrence.occurrenceId,
      })
    )
  })

  it('same-status re-commit (Error→Error) writes no occurrence', async () => {
    const previous = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Error,
      errorCode: DownloadErrorCode.NetworkError,
      errorMessage: 'connection reset',
      finishedAt: 5000,
    })
    const next = { ...previous, downloadedBytes: previous.downloadedBytes }
    const deps = {
      taskManager: {
        set: vi.fn(),
        getAll: vi.fn(() => [next]),
      },
      adapter: {},
      eventBus: { emit: vi.fn() },
      log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      persistTask: vi.fn(async () => undefined),
      persistTaskWithOccurrence: vi.fn(async () => undefined),
      occurrenceDispatcher: { dispatch: vi.fn(async () => undefined) },
      recordTransition: vi.fn(async () => undefined),
    }

    await commitTaskUpdate(
      previous,
      next,
      withDirectPublication(deps) as unknown as TaskActionDeps
    )

    expect(deps.persistTaskWithOccurrence).not.toHaveBeenCalled()
    expect(deps.persistTask).toHaveBeenCalledExactlyOnceWith(next)
    expect(deps.occurrenceDispatcher.dispatch).not.toHaveBeenCalled()
  })

  it('rethrows and publishes nothing when persistTaskWithOccurrence rejects', async () => {
    const previous = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Downloading,
    })
    const next = {
      ...previous,
      status: TaskStatus.Error,
      errorCode: DownloadErrorCode.NetworkError,
      errorMessage: 'connection reset',
    }
    const deps = {
      taskManager: {
        set: vi.fn(),
        getAll: vi.fn(() => [previous]),
      },
      adapter: {},
      eventBus: { emit: vi.fn() },
      log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      persistTask: vi.fn(async () => undefined),
      persistTaskWithOccurrence: vi
        .fn()
        .mockRejectedValue(new Error('db locked')),
      occurrenceDispatcher: { dispatch: vi.fn(async () => undefined) },
      recordTransition: vi.fn(async () => undefined),
    }

    await expect(
      commitTaskUpdate(
        previous,
        next,
        withDirectPublication(deps) as unknown as TaskActionDeps
      )
    ).rejects.toThrow('db locked')

    expect(deps.taskManager.set).not.toHaveBeenCalled()
    expect(deps.recordTransition).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).not.toHaveBeenCalled()
    expect(deps.occurrenceDispatcher.dispatch).not.toHaveBeenCalled()
  })
})

describe('commitPolledTerminalTransition', () => {
  it('a poll-detected Error emits exactly one occurrence; a later commit of the same terminal state emits none', async () => {
    const persistTaskWithOccurrence = vi.fn(async () => undefined)
    const dispatch = vi.fn(async () => undefined)
    const publish = vi.fn()
    const deps = {
      persistTaskWithOccurrence,
      occurrenceDispatcher: { dispatch },
      publish,
      log: { warn: vi.fn() },
    }
    const errored = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Error,
      errorCode: DownloadErrorCode.NetworkError,
      errorMessage: 'connection reset',
      finishedAt: 5000,
    })

    // First: poll detects Downloading -> Error.
    const first = await commitPolledTerminalTransition(
      TaskStatus.Downloading,
      errored,
      deps
    )
    expect(first).toBe('published')
    expect(publish).toHaveBeenCalledExactlyOnceWith(errored)
    expect(persistTaskWithOccurrence).toHaveBeenCalledExactlyOnceWith(
      errored,
      expect.objectContaining({
        fromStatus: TaskStatus.Downloading,
        cause: 'engine',
      })
    )
    expect(dispatch).toHaveBeenCalledTimes(1)

    // Second: another commit path (e.g. a duplicate poll tick, or a
    // different committing path racing the same transition) observes the
    // SAME already-terminal task — a same-status re-observation must emit
    // nothing further.
    const second = await commitPolledTerminalTransition(
      TaskStatus.Error,
      errored,
      deps
    )
    expect(second).toBe('not-terminal')
    expect(persistTaskWithOccurrence).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when the destination status is not terminal', async () => {
    const persistTaskWithOccurrence = vi.fn(async () => undefined)
    const dispatch = vi.fn(async () => undefined)
    const paused = makeDownloadTask({ id: 'task-1', status: TaskStatus.Paused })

    const publish = vi.fn()
    const outcome = await commitPolledTerminalTransition(
      TaskStatus.Downloading,
      paused,
      {
        persistTaskWithOccurrence,
        occurrenceDispatcher: { dispatch },
        publish,
        log: { warn: vi.fn() },
      }
    )

    expect(outcome).toBe('not-terminal')
    expect(persistTaskWithOccurrence).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it('BT race: a task whose status is already Completed (finalize won the race) emits no second occurrence when a late poll snapshot observes the same status', async () => {
    const persistTaskWithOccurrence = vi.fn(async () => undefined)
    const dispatch = vi.fn(async () => undefined)
    const publish = vi.fn()
    const deps = {
      persistTaskWithOccurrence,
      occurrenceDispatcher: { dispatch },
      publish,
      log: { warn: vi.fn() },
    }

    // finalizeTask already ran to completion: the published task is
    // Completed, idle, and renamed to its final path.
    const alreadyCompleted = makeDownloadTask({
      id: 'task-1',
      type: TaskType.Bt,
      engineTaskId: 'gid-1',
      status: TaskStatus.Completed,
      transitionPhase: TransitionPhase.Idle,
      diskPath: '/downloads/file',
      finalPath: '/downloads/file',
      finishedAt: 5000,
    })

    // A poll tick's aria2 snapshot for the same gid, captured around the
    // same time finalize committed, also reports Completed once merged.
    const staleEngineSnapshot = { ...alreadyCompleted }
    const merged = mergeEngineTask(alreadyCompleted, staleEngineSnapshot)

    // Mirrors handlePolledTasks' own gate (`existing.status !== merged.status`):
    // a same-status re-observation never even reaches
    // commitPolledTerminalTransition in production. Asserted here directly
    // so the invariant is pinned independent of the inline poll-loop code.
    expect(merged.status).toBe(alreadyCompleted.status)

    const outcome = await commitPolledTerminalTransition(
      alreadyCompleted.status,
      merged,
      deps
    )

    expect(outcome).toBe('not-terminal')
    expect(persistTaskWithOccurrence).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it('does not publish or dispatch when the durable write fails', async () => {
    const publish = vi.fn()
    const dispatch = vi.fn(async () => undefined)
    const log = { warn: vi.fn() }
    const errored = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Error,
      errorCode: DownloadErrorCode.NetworkError,
      finishedAt: 5000,
    })

    const outcome = await commitPolledTerminalTransition(
      TaskStatus.Downloading,
      errored,
      {
        persistTaskWithOccurrence: vi.fn(async () => {
          throw new Error('disk full')
        }),
        occurrenceDispatcher: { dispatch },
        publish,
        log,
      }
    )

    expect(outcome).toBe('persist-failed')
    expect(publish).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledOnce()
  })

  it('publishes inside the task mutation, after the durable write resolves', async () => {
    const order: string[] = []
    const completed = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Completed,
      finishedAt: 5000,
    })

    const outcome = await commitPolledTerminalTransition(
      TaskStatus.Downloading,
      completed,
      {
        persistTaskWithOccurrence: vi.fn(async () => {
          order.push('persist')
        }),
        occurrenceDispatcher: {
          dispatch: vi.fn(async () => {
            order.push('dispatch')
          }),
        },
        publish: () => order.push('publish'),
        runTaskMutation: async (taskIds, operation) => {
          order.push(`lock:${taskIds.join(',')}`)
          const result = await operation()
          order.push('unlock')
          return result
        },
        log: { warn: vi.fn() },
      }
    )

    expect(outcome).toBe('published')
    expect(order).toEqual([
      'lock:task-1',
      'persist',
      'publish',
      'dispatch',
      'unlock',
    ])
  })
})

describe('commitTaskUpdate publisher routing', () => {
  function makeMockDeps(next: ReturnType<typeof makeDownloadTask>) {
    return {
      taskManager: {
        set: vi.fn(),
        getAll: vi.fn(() => [next]),
      },
      adapter: {},
      eventBus: { emit: vi.fn() },
      log: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      persistTask: vi.fn(async () => {}),
    }
  }

  it('routes a non-terminal commit through publishTaskUpdate, not the bus', async () => {
    const previous = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Downloading,
    })
    const next = { ...previous, status: TaskStatus.Paused }
    const publishTaskUpdate = vi.fn()
    const publishTaskUpdateNow = vi.fn()
    const deps = {
      ...makeMockDeps(next),
      publishTaskUpdate,
      publishTaskUpdateNow,
    }

    await commitTaskUpdate(
      previous,
      next,
      withDirectPublication(deps) as unknown as TaskActionDeps
    )

    expect(publishTaskUpdate).toHaveBeenCalledTimes(1)
    expect(publishTaskUpdateNow).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).not.toHaveBeenCalled()
  })

  it('forces publishTaskUpdateNow before dispatch on a terminal commit', async () => {
    const previous = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Downloading,
    })
    const next = {
      ...previous,
      status: TaskStatus.Completed,
      finishedAt: 1_000,
    }
    const order: string[] = []
    const publishTaskUpdate = vi.fn()
    const publishTaskUpdateNow = vi.fn(() => order.push('publishNow'))
    const deps = {
      ...makeMockDeps(next),
      persistTaskWithOccurrence: vi.fn(async () => {}),
      occurrenceDispatcher: {
        dispatch: vi.fn(async () => {
          order.push('dispatch')
        }),
      },
      publishTaskUpdate,
      publishTaskUpdateNow,
    }

    await commitTaskUpdate(
      previous,
      next,
      withDirectPublication(deps) as unknown as TaskActionDeps
    )

    expect(order).toEqual(['publishNow', 'dispatch'])
    expect(publishTaskUpdate).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).not.toHaveBeenCalled()
  })

  it('a terminal-to-non-terminal transition (re-add) rides the trailing window', async () => {
    const previous = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Error,
    })
    const next = {
      ...previous,
      status: TaskStatus.Downloading,
      errorCode: null,
      errorMessage: null,
    }
    const publishTaskUpdate = vi.fn()
    const publishTaskUpdateNow = vi.fn()
    const deps = {
      taskManager: { set: vi.fn(), getAll: vi.fn(() => [next]) },
      adapter: {},
      eventBus: { emit: vi.fn() },
      log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      persistTask: vi.fn(async () => {}),
      publishTaskUpdate,
      publishTaskUpdateNow,
    }

    await commitTaskUpdate(
      previous,
      next,
      withDirectPublication(deps) as unknown as TaskActionDeps
    )

    // Bulk ReAddTasks commits N of these edges concurrently: forcing an
    // immediate flush per edge would reintroduce N full-list broadcasts.
    // The bridge's terminal dedup keys on the terminal identity, so the
    // edge frame is not needed for a later re-completion to notify.
    expect(publishTaskUpdate).toHaveBeenCalledTimes(1)
    expect(publishTaskUpdateNow).not.toHaveBeenCalled()
  })

  it('re-terminating inside one window still notifies the bridge twice', async () => {
    const taskManager = new TaskManager()
    const eventBus = new EventBus()
    const scheduled: Array<() => void> = []
    const publisher = new TaskUpdatePublisher(
      { taskManager, eventBus },
      {
        scheduler: {
          set: (fn) => scheduled.push(fn) - 1,
          clear: (handle) => {
            scheduled.splice(handle as number, 1)
          },
        },
      }
    )
    const seen = new Map<string, string>()
    const completed = vi.fn()
    eventBus.on(Events.TaskUpdated, (...args: unknown[]) => {
      dispatchTaskUpdates(args[0] as DownloadTask[], seen, {
        onProgress: vi.fn(),
        onCompleted: completed,
        onError: vi.fn(),
      })
    })
    const deps = {
      taskManager,
      adapter: {},
      eventBus,
      log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      persistTask: vi.fn(async () => {}),
      publishTaskUpdate: () => publisher.publish(),
      publishTaskUpdateNow: () => publisher.publishNow(),
    } as unknown as TaskActionDeps

    const base = makeDownloadTask({
      id: 'task-1',
      status: TaskStatus.Downloading,
    })
    taskManager.set('task-1', base)
    // 1. finish → Completed (terminal occurrence → immediate frame)
    await commitTaskUpdate(
      base,
      { ...base, status: TaskStatus.Completed, finishedAt: 1_000 },
      deps
    )
    // 2. re-add → Downloading, then 3. re-finish, all inside one window
    const completedTask = taskManager.getById('task-1')
    if (!completedTask) throw new Error('task lost')
    await commitTaskUpdate(
      completedTask,
      { ...completedTask, status: TaskStatus.Downloading, finishedAt: null },
      deps
    )
    const downloading = taskManager.getById('task-1')
    if (!downloading) throw new Error('task lost')
    await commitTaskUpdate(
      downloading,
      { ...downloading, status: TaskStatus.Completed, finishedAt: 2_000 },
      deps
    )
    for (const fn of scheduled.splice(0)) fn()

    expect(completed).toHaveBeenCalledTimes(2)
  })

  it('a terminal commit inside a coalescing burst reaches the bus immediately, without a duplicate trailing emit', async () => {
    const taskManager = new TaskManager()
    const eventBus = new EventBus()
    const scheduled: Array<() => void> = []
    const publisher = new TaskUpdatePublisher(
      { taskManager, eventBus },
      {
        scheduler: {
          set: (fn) => scheduled.push(fn) - 1,
          clear: (handle) => {
            scheduled.splice(handle as number, 1)
          },
        },
      }
    )
    const payloads: DownloadTask[][] = []
    eventBus.on(Events.TaskUpdated, (...args: unknown[]) => {
      payloads.push(args[0] as DownloadTask[])
    })
    const deps = {
      taskManager,
      adapter: {},
      eventBus,
      log: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      persistTask: vi.fn(async () => {}),
      publishTaskUpdate: () => publisher.publish(),
      publishTaskUpdateNow: () => publisher.publishNow(),
    }

    const a = makeDownloadTask({ id: 'a', status: TaskStatus.Downloading })
    taskManager.set('a', a)
    await commitTaskUpdate(
      a,
      { ...a, status: TaskStatus.Paused },
      withDirectPublication(deps) as unknown as TaskActionDeps
    )
    expect(payloads).toHaveLength(0)

    const b = makeDownloadTask({
      id: 'b',
      engineTaskId: 'gid-b',
      status: TaskStatus.Downloading,
    })
    taskManager.set('b', b)
    await commitTaskUpdate(
      b,
      { ...b, status: TaskStatus.Completed, finishedAt: 1_000 },
      withDirectPublication(deps) as unknown as TaskActionDeps
    )

    expect(payloads).toHaveLength(1)
    const snapshot = payloads[0]
    expect(snapshot?.find((t) => t.id === 'b')?.status).toBe(
      TaskStatus.Completed
    )
    expect(snapshot?.find((t) => t.id === 'a')?.status).toBe(TaskStatus.Paused)

    for (const fn of scheduled.splice(0)) fn()
    expect(payloads).toHaveLength(1)
  })
})
