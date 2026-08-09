import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { directTaskUpdatePublication } from '@test-utils/task-update'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { registerTasksBulkRoutes, type TasksBulkDeps } from './tasks-bulk'

function createDeps(): TasksBulkDeps {
  const active = makeDownloadTask({
    id: 'active',
    engineTaskId: 'gid-active',
    status: TaskStatus.Downloading,
  })
  const paused = makeDownloadTask({
    id: 'paused',
    engineTaskId: 'gid-paused',
    status: TaskStatus.Paused,
  })
  const tasks = new Map([
    [active.id, active],
    [paused.id, paused],
  ])
  const base = {
    taskManager: {
      getAll: vi.fn(() => [...tasks.values()]),
      getById: vi.fn((id: string) => tasks.get(id)),
      set: vi.fn((id: string, task) => tasks.set(id, task)),
    } as unknown as TasksBulkDeps['taskManager'],
    adapter: {
      pauseTask: vi.fn().mockResolvedValue(undefined),
      resumeTask: vi.fn().mockResolvedValue(undefined),
      getTaskStatus: vi.fn().mockResolvedValue(null),
    } as unknown as TasksBulkDeps['adapter'],
    eventBus: {
      emit: vi.fn(),
    } as unknown as TasksBulkDeps['eventBus'],
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as TasksBulkDeps['log'],
    persistTask: vi.fn().mockResolvedValue(undefined),
    recordTransition: vi.fn().mockResolvedValue(undefined),
  }
  return { ...base, ...directTaskUpdatePublication(base) }
}

describe('tasks-bulk routes', () => {
  it('POST /api/tasks/pause-all pauses eligible tasks by public identity', async () => {
    const app = Fastify()
    const deps = createDeps()
    registerTasksBulkRoutes(app, deps)
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/pause-all',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(deps.adapter.pauseTask).toHaveBeenCalledWith('gid-active')
    expect(deps.adapter.pauseTask).not.toHaveBeenCalledWith('gid-paused')
    await app.close()
  })

  it('POST /api/tasks/resume-all resumes eligible tasks by public identity', async () => {
    const app = Fastify()
    const deps = createDeps()
    registerTasksBulkRoutes(app, deps)
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/resume-all',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(deps.adapter.resumeTask).toHaveBeenCalledWith('gid-paused')
    expect(deps.adapter.resumeTask).not.toHaveBeenCalledWith('gid-active')
    await app.close()
  })
})
