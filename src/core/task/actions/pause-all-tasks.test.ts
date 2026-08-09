import { Events } from '@shared/protocol/events'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { directTaskUpdatePublication } from '@test-utils/task-update'
import { describe, expect, it, vi } from 'vitest'
import { EventBus } from '../../events/event-bus'
import { TaskManager } from '../task-manager'
import { TaskUpdatePublisher } from '../task-update-publisher'
import {
  pauseAllTasks,
  runBulkTaskAction,
  toBulkTaskCommandResult,
} from './pause-all-tasks'
import { pauseTask } from './pause-task'
import type { TaskActionDeps } from './shared'
import { commitTaskUpdate } from './shared'

describe('runBulkTaskAction (explicit ids)', () => {
  it('runs the action over the given ids and maps per-task outcomes', async () => {
    const first = makeDownloadTask({
      id: 'task-1',
      engineTaskId: 'gid-1',
      status: TaskStatus.Downloading,
    })
    const second = makeDownloadTask({
      id: 'task-2',
      engineTaskId: 'gid-2',
      status: TaskStatus.Downloading,
    })
    const tasks = new Map([
      [first.id, first],
      [second.id, second],
    ])
    const publishTaskUpdateNow = vi.fn()
    const deps = {
      taskManager: {
        getAll: vi.fn(() => [...tasks.values()]),
        getById: vi.fn((id: string) => tasks.get(id)),
        set: vi.fn((id: string, task: typeof first) => tasks.set(id, task)),
      },
      adapter: {
        pauseTask: vi.fn(async (gid: string) => {
          if (gid === 'gid-2') throw new Error('engine rejected')
        }),
        getTaskStatus: vi.fn().mockResolvedValue(null),
      },
      eventBus: { emit: vi.fn() },
      log: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      persistTask: vi.fn().mockResolvedValue(undefined),
      recordTransition: vi.fn().mockResolvedValue(undefined),
      publishTaskUpdate: vi.fn(),
      publishTaskUpdateNow,
    }

    const result = await runBulkTaskAction(
      ['task-1', 'task-2'],
      deps as unknown as TaskActionDeps,
      pauseTask
    )

    expect(result.succeeded).toEqual(['task-1'])
    expect(result.failed).toEqual([
      { taskId: 'task-2', error: expect.any(Error) },
    ])
    // The bulk close still forces one immediate flush.
    expect(publishTaskUpdateNow).toHaveBeenCalledTimes(1)
  })
})

describe('bulk terminal-edge coalescing', () => {
  it('bulk re-add of terminal tasks coalesces to at most two broadcasts', async () => {
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
    let broadcasts = 0
    eventBus.on(Events.TaskUpdated, () => {
      broadcasts += 1
    })
    const ids = ['t-1', 't-2', 't-3']
    for (const id of ids) {
      taskManager.set(
        id,
        makeDownloadTask({ id, status: TaskStatus.Error, finishedAt: 1_000 })
      )
    }
    const deps = {
      taskManager,
      adapter: {},
      eventBus,
      log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      persistTask: vi.fn(async () => {}),
      publishTaskUpdate: () => publisher.publish(),
      publishTaskUpdateNow: () => publisher.publishNow(),
    } as unknown as TaskActionDeps

    // Each action commits the re-add's Error→Downloading edge — the exact
    // shape that must NOT force one full-list broadcast per task.
    await runBulkTaskAction(ids, deps, async (id, d) => {
      const current = d.taskManager.getById(id)
      if (!current) throw new Error('missing')
      await commitTaskUpdate(
        current,
        { ...current, status: TaskStatus.Downloading, finishedAt: null },
        d
      )
    })
    for (const fn of scheduled.splice(0)) fn()

    expect(broadcasts).toBeLessThanOrEqual(2)
  })
})

describe('toBulkTaskCommandResult', () => {
  it('stringifies per-task errors for the IPC boundary', () => {
    expect(
      toBulkTaskCommandResult({
        succeeded: ['a'],
        failed: [
          { taskId: 'b', error: new Error('engine rejected') },
          { taskId: 'c', error: 'raw string' },
        ],
      })
    ).toEqual({
      succeeded: ['a'],
      failed: [
        { taskId: 'b', reason: 'engine rejected' },
        { taskId: 'c', reason: 'raw string' },
      ],
    })
  })
})

describe('pauseAllTasks', () => {
  it('snapshots eligible public task IDs and reports partial failures', async () => {
    const first = makeDownloadTask({
      id: 'task-1',
      engineTaskId: 'gid-1',
      status: TaskStatus.Downloading,
    })
    const second = makeDownloadTask({
      id: 'task-2',
      engineTaskId: 'gid-2',
      status: TaskStatus.Downloading,
    })
    const completed = makeDownloadTask({
      id: 'task-3',
      engineTaskId: 'gid-3',
      status: TaskStatus.Completed,
    })
    const tasks = new Map([
      [first.id, first],
      [second.id, second],
      [completed.id, completed],
    ])
    const deps = {
      taskManager: {
        getAll: vi.fn(() => [...tasks.values()]),
        getById: vi.fn((id: string) => tasks.get(id)),
        set: vi.fn((id: string, task: typeof first) => tasks.set(id, task)),
      },
      adapter: {
        pauseTask: vi.fn(async (gid: string) => {
          if (gid === 'gid-2') throw new Error('engine rejected')
        }),
        getTaskStatus: vi.fn().mockResolvedValue(null),
        pauseAll: vi.fn(),
      },
      eventBus: { emit: vi.fn() },
      log: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      persistTask: vi.fn().mockResolvedValue(undefined),
      recordTransition: vi.fn().mockResolvedValue(undefined),
    }

    const result = await pauseAllTasks({
      ...deps,
      ...directTaskUpdatePublication(deps),
    } as unknown as TaskActionDeps)

    expect(deps.adapter.pauseAll).not.toHaveBeenCalled()
    expect(deps.adapter.pauseTask).toHaveBeenCalledWith('gid-1')
    expect(deps.adapter.pauseTask).toHaveBeenCalledWith('gid-2')
    expect(deps.adapter.pauseTask).not.toHaveBeenCalledWith('gid-3')
    expect(result.succeeded).toEqual(['task-1'])
    expect(result.failed).toEqual([
      { taskId: 'task-2', error: expect.any(Error) },
    ])
    expect(deps.recordTransition).toHaveBeenCalledTimes(1)
  })

  it('forces one immediate flush after the fan-out settles', async () => {
    const downloading = makeDownloadTask({
      id: 'task-1',
      engineTaskId: 'gid-1',
      status: TaskStatus.Downloading,
    })
    const tasks = new Map([[downloading.id, downloading]])
    const publishTaskUpdate = vi.fn()
    const publishTaskUpdateNow = vi.fn()
    const deps = {
      taskManager: {
        getAll: vi.fn(() => [...tasks.values()]),
        getById: vi.fn((id: string) => tasks.get(id)),
        set: vi.fn((id: string, task: typeof downloading) =>
          tasks.set(id, task)
        ),
      },
      adapter: {
        pauseTask: vi.fn().mockResolvedValue(undefined),
        getTaskStatus: vi.fn().mockResolvedValue(null),
      },
      eventBus: { emit: vi.fn() },
      log: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      persistTask: vi.fn().mockResolvedValue(undefined),
      recordTransition: vi.fn().mockResolvedValue(undefined),
      publishTaskUpdate,
      publishTaskUpdateNow,
    }

    await pauseAllTasks(deps as unknown as TaskActionDeps)

    // Per-task commits coalesce; the bulk action closes with one forced
    // flush so the user does not wait out the trailing window.
    expect(publishTaskUpdateNow).toHaveBeenCalledTimes(1)
  })

  it('does not force a flush when no task was eligible', async () => {
    const completed = makeDownloadTask({
      id: 'task-1',
      engineTaskId: 'gid-1',
      status: TaskStatus.Completed,
    })
    const publishTaskUpdateNow = vi.fn()
    const deps = {
      taskManager: {
        getAll: vi.fn(() => [completed]),
        getById: vi.fn(() => completed),
        set: vi.fn(),
      },
      adapter: {
        pauseTask: vi.fn(),
        getTaskStatus: vi.fn().mockResolvedValue(null),
      },
      eventBus: { emit: vi.fn() },
      log: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      persistTask: vi.fn().mockResolvedValue(undefined),
      recordTransition: vi.fn().mockResolvedValue(undefined),
      publishTaskUpdate: vi.fn(),
      publishTaskUpdateNow,
    }

    await pauseAllTasks(deps as unknown as TaskActionDeps)

    expect(publishTaskUpdateNow).not.toHaveBeenCalled()
  })
})
