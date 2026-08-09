import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { directTaskUpdatePublication } from '@test-utils/task-update'
import { describe, expect, it, vi } from 'vitest'
import { resumeAllTasks } from './resume-all-tasks'
import type { TaskActionDeps } from './shared'

describe('resumeAllTasks', () => {
  it('uses per-task public actions instead of the engine-wide RPC', async () => {
    const paused = makeDownloadTask({
      id: 'task-1',
      engineTaskId: 'gid-1',
      status: TaskStatus.Paused,
    })
    const active = makeDownloadTask({
      id: 'task-2',
      engineTaskId: 'gid-2',
      status: TaskStatus.Downloading,
    })
    const tasks = new Map([
      [paused.id, paused],
      [active.id, active],
    ])
    const deps = {
      taskManager: {
        getAll: vi.fn(() => [...tasks.values()]),
        getById: vi.fn((id: string) => tasks.get(id)),
        set: vi.fn((id: string, task: typeof paused) => tasks.set(id, task)),
      },
      adapter: {
        resumeTask: vi.fn().mockResolvedValue(undefined),
        getTaskStatus: vi.fn().mockResolvedValue(null),
        resumeAll: vi.fn(),
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

    const result = await resumeAllTasks({
      ...deps,
      ...directTaskUpdatePublication(deps),
    } as unknown as TaskActionDeps)

    expect(deps.adapter.resumeAll).not.toHaveBeenCalled()
    expect(deps.adapter.resumeTask).toHaveBeenCalledWith('gid-1')
    expect(deps.adapter.resumeTask).not.toHaveBeenCalledWith('gid-2')
    expect(result).toEqual({ succeeded: ['task-1'], failed: [] })
    expect(deps.recordTransition).toHaveBeenCalledTimes(1)
  })
})
