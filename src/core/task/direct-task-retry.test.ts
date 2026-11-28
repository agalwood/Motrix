import type { EngineAdapter } from '@core/engine/engine-adapter'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it, vi } from 'vitest'
import { createGetTaskHttpRetryAvailabilityHandler } from './direct-task-retry'
import type { TaskManager } from './task-manager'

describe('HTTP retry availability', () => {
  it('rejects missing persisted ownership before consulting the engine', async () => {
    const task = makeDownloadTask({
      status: TaskStatus.Error,
      diskPath: '/downloads/file.motrix',
    })
    const adapter = {
      canRetryDirectTask: vi.fn(),
      retryDirectTask: vi.fn(),
    } as unknown as EngineAdapter
    const handler = createGetTaskHttpRetryAvailabilityHandler(
      { getById: () => task } as unknown as TaskManager,
      adapter
    )
    expect(await handler([task.id, task.id])).toEqual([])
    expect(adapter.canRetryDirectTask).not.toHaveBeenCalled()
  })
})
