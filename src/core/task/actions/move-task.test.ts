import { directTaskUpdatePublication } from '@test-utils/task-update'
import { describe, expect, it, vi } from 'vitest'
import type { EngineAdapter } from '../../engine/engine-adapter'
import type { EventBus } from '../../events/event-bus'
import type { Logger } from '../../logger'
import type { TaskManager } from '../task-manager'
import { moveTask } from './move-task'

function makeDeps(
  task: { id: string; engineTaskId: string } | undefined = {
    id: 't1',
    engineTaskId: 'gid-1',
  }
) {
  const base = {
    taskManager: {
      getById: vi.fn().mockReturnValue(task),
    } as unknown as TaskManager,
    adapter: {
      changePosition: vi.fn().mockResolvedValue(2),
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
  }
  return { ...base, ...directTaskUpdatePublication(base) }
}

describe('moveTask', () => {
  it('up shifts by -1 with POS_CUR', async () => {
    const deps = makeDeps()
    await moveTask('t1', 'up', deps)
    expect(deps.adapter.changePosition).toHaveBeenCalledWith(
      'gid-1',
      -1,
      'POS_CUR'
    )
  })

  it('down shifts by +1 with POS_CUR', async () => {
    const deps = makeDeps()
    await moveTask('t1', 'down', deps)
    expect(deps.adapter.changePosition).toHaveBeenCalledWith(
      'gid-1',
      1,
      'POS_CUR'
    )
  })

  it('swallows out-of-range errors (next polling reconciles)', async () => {
    const deps = makeDeps()
    ;(
      deps.adapter.changePosition as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error('position out of range'))
    await expect(moveTask('t1', 'up', deps)).resolves.toBeUndefined()
    expect(deps.log.warn).toHaveBeenCalled()
  })
})
