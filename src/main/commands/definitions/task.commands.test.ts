import { CommandIds } from '@shared/commands-catalog'
import { describe, expect, it, vi } from 'vitest'
import { CommandRegistry } from '../command-registry'
import { DEFAULT_MENU_CONTEXT } from '../menu-context'
import type { CommandDeps } from '../types'
import { registerTaskCommands } from './task.commands'

const actionMocks = vi.hoisted(() => ({
  clearStoppedTasks: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@core/task/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core/task/actions')>()),
  clearStoppedTasks: actionMocks.clearStoppedTasks,
}))

describe('task commands', () => {
  it('wires Clear Stopped to the shared persistence coordinator', async () => {
    const registry = new CommandRegistry()
    const taskManager = { marker: 'task-manager' }
    const adapter = { marker: 'adapter' }
    const motrixDatabase = { marker: 'database' }
    const taskPersistence = {
      runExclusivePersistence: vi.fn(),
    }
    const eventBus = { marker: 'event-bus' }
    const log = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }
    const deps = {
      taskManager,
      adapter,
      motrixDatabase,
      taskPersistence,
      eventBus,
      log,
    } as unknown as CommandDeps
    registerTaskCommands(registry, deps)

    await registry.execute(CommandIds.TaskClearStopped, undefined, {
      menuContext: { ...DEFAULT_MENU_CONTEXT, hasStoppedTasks: true },
      deps,
    })

    expect(actionMocks.clearStoppedTasks).toHaveBeenCalledOnce()
    expect(actionMocks.clearStoppedTasks).toHaveBeenCalledWith({
      taskManager,
      adapter,
      db: motrixDatabase,
      taskPersistence,
      eventBus,
      log,
    })
  })
})
