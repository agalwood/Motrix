import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandRegistry } from '../commands/command-registry'
import { ContextStore } from '../commands/context-store'
import { KeybindingRegistry } from '../commands/keybindings/keybinding-registry'
import type { CommandDeps } from '../commands/types'
import { MainProcessWorkCoordinator } from '../main-process-work-coordinator'
import { MenuIds } from './menu-ids'
import { MenuManager } from './menu-manager'
import { MenuRegistry } from './menu-registry'

const electronMenu = vi.hoisted(() => {
  const clicks: Array<() => void> = []
  return {
    clicks,
    buildFromTemplate: vi.fn((template: unknown[]) => {
      const collect = (items: unknown[]): void => {
        for (const raw of items) {
          const item = raw as {
            click?: () => void
            submenu?: unknown[]
          }
          if (item.click) clicks.push(item.click)
          if (Array.isArray(item.submenu)) collect(item.submenu)
        }
      }
      collect(template)
      return { items: [] }
    }),
    setApplicationMenu: vi.fn(),
  }
})

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: electronMenu.buildFromTemplate,
    setApplicationMenu: electronMenu.setApplicationMenu,
  },
}))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve
  })
  return { promise, resolve }
}

describe('MenuManager command lifecycle', () => {
  beforeEach(() => {
    electronMenu.clicks.length = 0
    electronMenu.buildFromTemplate.mockClear()
    electronMenu.setApplicationMenu.mockClear()
  })

  it('tracks accepted native clicks, rejects late clicks, and disables the native menu', async () => {
    const commandRegistry = new CommandRegistry()
    const menuRegistry = new MenuRegistry()
    const contextStore = new ContextStore()
    const coordinator = new MainProcessWorkCoordinator()
    const commandGate = deferred()
    const commandStarted = deferred()
    const onApplicationMenuSet = vi.fn()
    const run = vi.fn(async () => {
      commandStarted.resolve()
      await commandGate.promise
    })
    commandRegistry.register({
      id: 'test.command',
      title: 'test.command',
      run,
    })
    menuRegistry.appendItem({
      id: 'menubar.task.test',
      type: 'normal',
      menuId: MenuIds.MenubarTask,
      commandId: 'test.command',
      group: '1_test',
    })
    const manager = new MenuManager({
      commandRegistry,
      menuRegistry,
      keybindingRegistry: new KeybindingRegistry(),
      contextStore,
      commandDeps: {
        log: {
          error: vi.fn(),
        },
      } as unknown as CommandDeps,
      trackAsyncWork: (operation) => coordinator.run(operation),
      onApplicationMenuSet,
    })
    manager.install()
    expect(onApplicationMenuSet).toHaveBeenCalledOnce()
    const click = electronMenu.clicks[0]
    expect(click).toBeTypeOf('function')

    click()
    await commandStarted.promise
    let drained = false
    const drain = coordinator.stopAndDrain().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    manager.disable()
    expect(electronMenu.setApplicationMenu).toHaveBeenLastCalledWith(null)
    click()
    await Promise.resolve()
    expect(run).toHaveBeenCalledOnce()

    commandGate.resolve()
    await drain
    expect(drained).toBe(true)
  })
})
