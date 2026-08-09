import { Events } from '@shared/protocol/events'
import type { DownloadTask, TaskInstance } from '@shared/types/task'
import {
  TaskInstancePhase,
  TaskStatus,
  TransitionPhase,
} from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it, vi } from 'vitest'
import type { ClearStoppedTasksDeps } from './clear-stopped-tasks'
import { clearStoppedTasks } from './clear-stopped-tasks'

function instance(taskId: string, gid: string, index: number): TaskInstance {
  return {
    instanceId: `${taskId}-instance-${index}`,
    motrixId: taskId,
    gid,
    phase: TaskInstancePhase.HttpDownload,
    status: TaskStatus.Completed,
    progress: 1,
    totalBytes: 1,
    downloadedBytes: 1,
    uploadedBytes: 0,
    diskPath: '',
    transitionPhase: TransitionPhase.Idle,
    uris: [],
    uriHash: null,
    payload: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

function task(
  id: string,
  status: TaskStatus,
  options: { engineTaskId?: string; instanceGids?: string[] } = {}
): DownloadTask {
  const engineTaskId = options.engineTaskId ?? `gid-${id}`
  return makeDownloadTask({
    id,
    engineTaskId,
    status,
    instances: (options.instanceGids ?? []).map((gid, index) =>
      instance(id, gid, index)
    ),
  })
}

function createDeps(initial: readonly DownloadTask[]) {
  const tasks = new Map(initial.map((item) => [item.id, item]))
  const taskManager = {
    getAll: vi.fn(() => [...tasks.values()]),
    getById: vi.fn((id: string) => tasks.get(id)),
    remove: vi.fn((id: string) => tasks.delete(id)),
  }
  const eventBus = {
    emit: vi.fn(),
  }
  const deps = {
    taskManager,
    adapter: {
      removeDownloadResults: vi.fn<
        (gids: readonly string[]) => Promise<PromiseSettledResult<void>[]>
      >(async (gids) =>
        gids.map(() => ({ status: 'fulfilled' as const, value: undefined }))
      ),
    },
    db: {
      deleteTasks: vi.fn(),
    },
    taskPersistence: {
      runExclusivePersistence: vi.fn(
        async (operation: () => unknown | Promise<unknown>) => operation()
      ) as unknown as ClearStoppedTasksDeps['taskPersistence']['runExclusivePersistence'],
    },
    eventBus,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    // Spy pass-through: the action must force one immediate flush; the
    // pass-through keeps the legacy eventBus.emit payload assertions valid.
    publishTaskUpdateNow: vi.fn(() =>
      eventBus.emit(Events.TaskUpdated, taskManager.getAll())
    ),
    deleteParentTasks: vi.fn(
      async (
        _taskIds: readonly string[],
        deleteParents: () => void | Promise<void>
      ) => deleteParents()
    ),
  } satisfies ClearStoppedTasksDeps

  return { deps, tasks }
}

describe('clearStoppedTasks', () => {
  it('deletes Completed, Error, and Removed while retaining active tasks', async () => {
    const { deps, tasks } = createDeps([
      task('active', TaskStatus.Downloading),
      task('completed', TaskStatus.Completed),
      task('error', TaskStatus.Error),
      task('paused', TaskStatus.Paused),
      task('removed', TaskStatus.Removed),
    ])

    await clearStoppedTasks(deps)

    expect(deps.db.deleteTasks).toHaveBeenCalledWith([
      'completed',
      'error',
      'removed',
    ])
    expect([...tasks.keys()]).toEqual(['active', 'paused'])
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      Events.TaskUpdated,
      expect.arrayContaining([
        expect.objectContaining({ id: 'active' }),
        expect.objectContaining({ id: 'paused' }),
      ])
    )
  })

  it('deduplicates engineTaskId and every non-empty instance gid', async () => {
    const { deps } = createDeps([
      task('multi', TaskStatus.Completed, {
        engineTaskId: 'gid-primary',
        instanceGids: ['gid-secondary', 'gid-primary', '', 'gid-third'],
      }),
    ])

    await clearStoppedTasks(deps)

    expect(deps.adapter.removeDownloadResults).toHaveBeenCalledExactlyOnceWith([
      'gid-primary',
      'gid-secondary',
      'gid-third',
    ])
  })

  it('retains only the task whose engine cleanup fails and continues', async () => {
    const { deps, tasks } = createDeps([
      task('broken', TaskStatus.Error),
      task('clean', TaskStatus.Completed),
    ])
    deps.adapter.removeDownloadResults.mockImplementation(async (gids) =>
      gids.map((gid) =>
        gid === 'gid-broken'
          ? { status: 'rejected' as const, reason: new Error('fault: denied') }
          : { status: 'fulfilled' as const, value: undefined }
      )
    )

    await clearStoppedTasks(deps)

    expect(deps.log.warn).toHaveBeenCalledOnce()
    expect(deps.db.deleteTasks).toHaveBeenCalledWith(['clean'])
    expect([...tasks.keys()]).toEqual(['broken'])
  })

  it('aggregates many per-candidate failures into one warning', async () => {
    const { deps, tasks } = createDeps([
      task('b-1', TaskStatus.Error),
      task('b-2', TaskStatus.Error),
      task('b-3', TaskStatus.Completed),
    ])
    // Every gid faults — e.g. a chunk-level transport failure reported as
    // per-entry rejections. A million-row history must not produce a
    // million warn lines (dev-mode logging is a synchronous file write).
    deps.adapter.removeDownloadResults.mockImplementation(async (gids) =>
      gids.map(() => ({
        status: 'rejected' as const,
        reason: new Error('request timed out'),
      }))
    )

    await clearStoppedTasks(deps)

    expect(deps.log.warn).toHaveBeenCalledTimes(1)
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ failedTasks: 3 }),
      expect.any(String)
    )
    expect(deps.db.deleteTasks).not.toHaveBeenCalled()
    expect([...tasks.keys()].sort()).toEqual(['b-1', 'b-2', 'b-3'])
  })

  it('retains every task when the whole batch RPC fails', async () => {
    const { deps, tasks } = createDeps([
      task('one', TaskStatus.Completed),
      task('two', TaskStatus.Error),
    ])
    deps.adapter.removeDownloadResults.mockRejectedValue(
      new Error('engine offline')
    )

    await clearStoppedTasks(deps)

    expect(deps.log.warn).toHaveBeenCalledOnce()
    expect(deps.db.deleteTasks).not.toHaveBeenCalled()
    expect([...tasks.keys()].sort()).toEqual(['one', 'two'])
  })

  it('revalidates status and gid identity inside the persistence queue', async () => {
    const resumed = task('resumed', TaskStatus.Completed)
    const replaced = task('replaced', TaskStatus.Error, {
      instanceGids: ['gid-old'],
    })
    const reordered = task('reordered', TaskStatus.Completed, {
      engineTaskId: 'gid-a',
      instanceGids: ['gid-b', 'gid-c'],
    })
    const { deps, tasks } = createDeps([resumed, replaced, reordered])
    deps.adapter.removeDownloadResults.mockImplementation(async (gids) => {
      for (const gid of gids) {
        if (gid === 'gid-resumed') {
          tasks.set('resumed', { ...resumed, status: TaskStatus.Downloading })
        }
        if (gid === 'gid-old') {
          tasks.set(
            'replaced',
            task('replaced', TaskStatus.Error, {
              engineTaskId: 'gid-replacement',
            })
          )
        }
        if (gid === 'gid-c') {
          tasks.set('reordered', {
            ...reordered,
            instances: [...reordered.instances].reverse(),
          })
        }
      }
      return gids.map(() => ({
        status: 'fulfilled' as const,
        value: undefined,
      }))
    })

    await clearStoppedTasks(deps)

    expect(deps.db.deleteTasks).toHaveBeenCalledWith(['reordered'])
    expect([...tasks.keys()].sort()).toEqual(['replaced', 'resumed'])
  })

  it('keeps memory unchanged and emits nothing when database deletion fails', async () => {
    const completed = task('completed', TaskStatus.Completed)
    const { deps, tasks } = createDeps([completed])
    deps.db.deleteTasks.mockImplementation(() => {
      throw new Error('disk full')
    })

    await expect(clearStoppedTasks(deps)).rejects.toThrow('disk full')

    expect(tasks.get('completed')).toBe(completed)
    expect(deps.taskManager.remove).not.toHaveBeenCalled()
    expect(deps.eventBus.emit).not.toHaveBeenCalled()
  })

  it('tombstones every selected task before the batched parent delete', async () => {
    const { deps } = createDeps([
      task('completed', TaskStatus.Completed),
      task('error', TaskStatus.Error),
    ])
    const order: string[] = []
    deps.deleteParentTasks.mockImplementation(
      async (taskIds, deleteParents) => {
        order.push(`tombstone:${taskIds.join(',')}`)
        await deleteParents()
      }
    )
    deps.db.deleteTasks.mockImplementation(() => {
      order.push('parent-delete')
    })

    await clearStoppedTasks(deps)

    expect(order).toEqual(['tombstone:completed,error', 'parent-delete'])
  })

  it('emits one command-owned snapshot and a second call is a no-op', async () => {
    const { deps } = createDeps([task('completed', TaskStatus.Completed)])

    await clearStoppedTasks(deps)
    await clearStoppedTasks(deps)

    expect(deps.db.deleteTasks).toHaveBeenCalledOnce()
    expect(deps.publishTaskUpdateNow).toHaveBeenCalledOnce()
    expect(deps.eventBus.emit).toHaveBeenCalledOnce()
    expect(deps.eventBus.emit).toHaveBeenCalledWith(Events.TaskUpdated, [])
    expect(deps.taskPersistence.runExclusivePersistence).toHaveBeenCalledTimes(
      2
    )
  })
})
