import { CommandIds } from '@shared/commands-catalog'
import { Events } from '@shared/protocol/events'
import { describe, expect, it, vi } from 'vitest'
import { CommandRegistry } from '../command-registry'
import { DEFAULT_MENU_CONTEXT } from '../menu-context'
import type { CommandDeps } from '../types'
import { registerAppCommands } from './app.commands'

describe('app commands', () => {
  it('opens About before checking for updates', async () => {
    const registry = new CommandRegistry()
    registerAppCommands(registry, {} as CommandDeps)
    const show = vi.fn()
    const emit = vi.fn()
    const check = vi.fn().mockResolvedValue(undefined)
    const deps = {
      windowManager: { show },
      eventBus: { emit },
      updateManager: {
        check,
        getState: () => ({ phase: 'idle', currentVersion: '2.0.0' }),
      },
      log: { error: vi.fn() },
    } as unknown as CommandDeps

    await registry.execute(CommandIds.AppCheckForUpdates, undefined, {
      menuContext: DEFAULT_MENU_CONTEXT,
      deps,
    })

    expect(show).toHaveBeenCalledWith('main')
    expect(emit).toHaveBeenCalledWith(Events.NavigateTo, '/settings/about')
    expect(check).toHaveBeenCalledOnce()
    expect(show.mock.invocationCallOrder[0]).toBeLessThan(
      check.mock.invocationCallOrder[0]
    )
    expect(emit.mock.invocationCallOrder[0]).toBeLessThan(
      check.mock.invocationCallOrder[0]
    )
  })

  it('still opens About but skips the check when updates are unsupported', async () => {
    const registry = new CommandRegistry()
    registerAppCommands(registry, {} as CommandDeps)
    const show = vi.fn()
    const emit = vi.fn()
    const check = vi.fn().mockResolvedValue(undefined)
    const deps = {
      windowManager: { show },
      eventBus: { emit },
      updateManager: {
        check,
        getState: () => ({ phase: 'unsupported', currentVersion: '2.0.0' }),
      },
      log: { error: vi.fn() },
    } as unknown as CommandDeps

    await registry.execute(CommandIds.AppCheckForUpdates, undefined, {
      menuContext: DEFAULT_MENU_CONTEXT,
      deps,
    })

    expect(show).toHaveBeenCalledWith('main')
    expect(emit).toHaveBeenCalledWith(Events.NavigateTo, '/settings/about')
    expect(check).not.toHaveBeenCalled()
  })
})
