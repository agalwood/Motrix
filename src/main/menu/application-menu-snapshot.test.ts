import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandRegistry } from '../commands/command-registry'
import { ContextStore } from '../commands/context-store'
import { KeybindingRegistry } from '../commands/keybindings/keybinding-registry'
import type { CommandDeps, CommandExecContext } from '../commands/types'
import { i18n } from '../lib/i18n'
import { MenuIds, MenuItemIds } from './menu-ids'
import { MenuManager } from './menu-manager'
import { MenuRegistry } from './menu-registry'

interface FakeMenuItem {
  id: string
  type: string
  label: string
  accelerator: unknown
  enabled: unknown
  visible: unknown
  checked: unknown
  submenu: FakeMenu | null
  click: unknown
}

interface FakeMenu {
  items: FakeMenuItem[]
}

const electronMenu = vi.hoisted(() => {
  const roleClicks = new Map<string, ReturnType<typeof vi.fn>>()
  const applicationMenus: unknown[] = []
  const checkedAssignments = new Map<string, unknown[]>()
  const radioChecked = new Map<string, boolean>()

  const build = (template: Array<Record<string, unknown>>): FakeMenu => {
    const menu: FakeMenu = {
      items: template.map((entry): FakeMenuItem => {
        const id = String(entry.id ?? '')
        const roleClick = entry.role ? vi.fn() : undefined
        if (roleClick) roleClicks.set(id, roleClick)
        const submenu = Array.isArray(entry.submenu)
          ? build(entry.submenu as Array<Record<string, unknown>>)
          : null
        const item: FakeMenuItem = {
          id,
          type: String(entry.type ?? (submenu ? 'submenu' : 'normal')),
          label: String(entry.label ?? ''),
          accelerator: entry.accelerator ?? null,
          enabled: entry.enabled ?? true,
          visible: entry.visible ?? true,
          checked: entry.checked ?? false,
          submenu,
          click: entry.click ?? roleClick,
        }
        if (item.type === 'radio') {
          radioChecked.set(id, Boolean(entry.checked))
          Object.defineProperty(item, 'checked', {
            configurable: true,
            get: () => radioChecked.get(id) ?? false,
            set: (value: unknown) => {
              const assignments = checkedAssignments.get(id) ?? []
              assignments.push(value)
              checkedAssignments.set(id, assignments)
              const ownIndex = menu.items.indexOf(item)
              let first = ownIndex
              let last = ownIndex
              while (menu.items[first - 1]?.type === 'radio') first -= 1
              while (menu.items[last + 1]?.type === 'radio') last += 1
              for (let index = first; index <= last; index += 1) {
                const sibling = menu.items[index]
                if (sibling) radioChecked.set(sibling.id, sibling === item)
              }
            },
          })
        }
        if (item.type === 'checkbox' || item.type === 'radio') {
          const commandClick = item.click as (() => void) | undefined
          item.click = () => {
            item.checked = !item.checked
            commandClick?.()
          }
        }
        return item
      }),
    }
    return menu
  }

  return {
    roleClicks,
    checkedAssignments,
    radioChecked,
    applicationMenus,
    buildFromTemplate: vi.fn(build),
    setApplicationMenu: vi.fn((menu: unknown) => {
      applicationMenus.push(menu)
    }),
  }
})

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: electronMenu.buildFromTemplate,
    setApplicationMenu: electronMenu.setApplicationMenu,
  },
}))

function createManager(
  options: {
    trackAsyncWork?: (operation: () => Promise<void>) => Promise<void>
  } = {}
) {
  const commandRegistry = new CommandRegistry()
  const menuRegistry = new MenuRegistry()
  const contextStore = new ContextStore()
  contextStore.merge({ platform: 'win32' })

  let onAboutRun = (): void => {}
  const aboutRun = vi.fn(async () => onAboutRun())
  const protectedRun = vi.fn(async (_context: CommandExecContext) => {})
  const hiddenRun = vi.fn(async () => {})
  const nestedRun = vi.fn(async () => {})
  let compactMode = true
  const onApplicationMenuSet = vi.fn()
  commandRegistry.register({
    id: 'test.about',
    title: 'menu.app.about',
    run: aboutRun,
  })
  commandRegistry.register({
    id: 'test.nested',
    title: 'menu.task.pauseTask',
    run: nestedRun,
  })
  commandRegistry.register({
    id: 'test.protected',
    title: 'menu.task.pauseTask',
    precondition: (context) => context.taskSelected,
    run: protectedRun,
  })
  commandRegistry.register({
    id: 'test.hidden',
    title: 'menu.help.website',
    run: hiddenRun,
  })

  menuRegistry.appendItem({
    id: MenuItemIds.AppAbout,
    type: 'normal',
    menuId: MenuIds.MenubarApp,
    group: '1_about',
    commandId: 'test.about',
  })
  menuRegistry.appendItem({
    id: 'menubar.window.mode.compact',
    type: 'radio',
    menuId: MenuIds.MenubarWindow,
    group: '2_mode',
    commandId: 'test.about',
    toggled: () => compactMode,
    radioGroupId: 'menubar.window.mode',
  })
  menuRegistry.appendItem({
    id: 'menubar.window.mode.comfortable',
    type: 'radio',
    menuId: MenuIds.MenubarWindow,
    group: '2_mode',
    commandId: 'test.about',
    toggled: () => !compactMode,
    radioGroupId: 'menubar.window.mode',
  })
  menuRegistry.appendItem({
    id: 'menubar.task.hiddenParent',
    type: 'submenu',
    menuId: MenuIds.MenubarTask,
    group: '2_hidden',
    submenu: MenuIds.MenubarFile,
    when: () => false,
  })
  menuRegistry.appendItem({
    id: 'menubar.file.nested',
    type: 'normal',
    menuId: MenuIds.MenubarFile,
    group: '1_nested',
    commandId: 'test.nested',
  })
  menuRegistry.appendItem({
    id: MenuItemIds.AppQuit,
    type: 'normal',
    menuId: MenuIds.MenubarApp,
    group: '9_quit',
    role: 'quit',
    titleOverride: 'menu.app.quit',
  })
  menuRegistry.appendItem({
    id: MenuItemIds.TaskPause,
    type: 'normal',
    menuId: MenuIds.MenubarTask,
    group: '1_task',
    commandId: 'test.protected',
    contextBinding: 'selectedTask',
  })
  menuRegistry.appendItem({
    id: MenuItemIds.EditCopy,
    type: 'normal',
    menuId: MenuIds.MenubarEdit,
    group: '1_edit',
    role: 'copy',
    titleOverride: 'menu.edit.copy',
  })
  menuRegistry.appendItem({
    id: MenuItemIds.WindowMinimize,
    type: 'normal',
    menuId: MenuIds.MenubarWindow,
    group: '1_window',
    role: 'minimize',
    titleOverride: 'menu.window.minimize',
  })
  menuRegistry.appendItem({
    id: MenuItemIds.HelpWebsite,
    type: 'normal',
    menuId: MenuIds.MenubarHelp,
    group: '1_help',
    commandId: 'test.hidden',
    when: () => false,
  })
  menuRegistry.appendItem({
    id: MenuItemIds.HelpToggleDevTools,
    type: 'normal',
    menuId: MenuIds.MenubarHelp,
    group: '2_help',
    role: 'toggleDevTools',
    titleOverride: 'menu.help.toggleDevTools',
  })

  const manager = new MenuManager({
    commandRegistry,
    menuRegistry,
    keybindingRegistry: new KeybindingRegistry(),
    contextStore,
    commandDeps: {
      log: { error: vi.fn() },
    } as unknown as CommandDeps,
    trackAsyncWork: options.trackAsyncWork,
    onApplicationMenuSet,
  })
  return {
    manager,
    contextStore,
    aboutRun,
    protectedRun,
    hiddenRun,
    nestedRun,
    onApplicationMenuSet,
    setCompactMode: (value: boolean) => {
      compactMode = value
      contextStore.merge({ currentRoute: value ? '/compact' : '/comfortable' })
    },
    setOnAboutRun: (run: () => void) => {
      onAboutRun = run
    },
  }
}

describe('MenuManager application-menu snapshot', () => {
  beforeEach(() => {
    electronMenu.roleClicks.clear()
    electronMenu.checkedAssignments.clear()
    electronMenu.radioChecked.clear()
    electronMenu.applicationMenus.length = 0
    electronMenu.buildFromTemplate.mockClear()
    electronMenu.setApplicationMenu.mockClear()
  })

  it('publishes an initially evaluated, stable dropdown projection', () => {
    const { manager } = createManager()
    const changed = vi.fn()
    manager.onApplicationMenuChanged(changed)

    manager.install()

    const snapshot = manager.getApplicationMenuSnapshot()
    expect(snapshot.revision).toBe(1)
    expect(snapshot.items.map((item) => item.id)).toEqual([
      MenuItemIds.AppAbout,
      MenuItemIds.ApplicationSubmenusSeparator,
      MenuIds.MenubarTask,
      MenuIds.MenubarEdit,
      MenuIds.MenubarWindow,
      MenuIds.MenubarHelp,
      MenuItemIds.ApplicationQuitSeparator,
      MenuItemIds.AppQuit,
    ])
    expect(snapshot.items[2]?.children?.[0]).toMatchObject({
      id: MenuItemIds.TaskPause,
      enabled: false,
      visible: true,
    })
    expect(
      snapshot.items[5]?.children?.find(
        (item) => item.id === MenuItemIds.HelpWebsite
      )
    ).toMatchObject({ visible: false })
    expect(changed).toHaveBeenCalledOnce()

    snapshot.items[0]!.label = 'mutated outside the manager'
    expect(manager.getApplicationMenuSnapshot().items[0]?.label).not.toBe(
      'mutated outside the manager'
    )
  })

  it('increments revision only for menu or command-context changes', () => {
    const { manager, contextStore } = createManager()
    const changed = vi.fn()
    manager.install()
    manager.onApplicationMenuChanged(changed)

    contextStore.merge({ currentRoute: '/settings' })
    expect(manager.getApplicationMenuSnapshot().revision).toBe(1)
    expect(changed).not.toHaveBeenCalled()

    contextStore.merge({ selectedTaskId: 'task-1' })
    expect(manager.getApplicationMenuSnapshot().revision).toBe(2)
    expect(changed).toHaveBeenCalledOnce()
    expect(
      manager.getApplicationMenuSnapshot().items[2]?.children?.[0]?.enabled
    ).toBe(true)

    contextStore.merge({ selectedTaskId: 'task-1' })
    expect(changed).toHaveBeenCalledOnce()

    contextStore.merge({ selectedTaskId: 'task-2' })
    expect(manager.getApplicationMenuSnapshot().revision).toBe(2)
    expect(changed).toHaveBeenCalledOnce()
  })

  it('rebuilds an evaluated menu and reapplies native visibility after a locale change', async () => {
    const originalLanguage = i18n.language
    const alternateLanguage = originalLanguage.startsWith('zh') ? 'en' : 'zh-CN'
    const { manager, contextStore, onApplicationMenuSet } = createManager()
    contextStore.merge({ selectedTaskId: 'task-1' })
    manager.install()

    await i18n.changeLanguage(alternateLanguage)

    expect(onApplicationMenuSet).toHaveBeenCalledTimes(2)
    expect(
      manager.getApplicationMenuSnapshot().items[2]?.children?.[0]
    ).toMatchObject({ enabled: true, visible: true })

    manager.dispose()
    await i18n.changeLanguage(originalLanguage)
  })

  it('revalidates revision and native state before executing current items', async () => {
    const { manager, contextStore, protectedRun, hiddenRun, nestedRun } =
      createManager()
    manager.install()
    const initialRevision = manager.getApplicationMenuSnapshot().revision
    const targetWindow = { webContents: {} } as Electron.BrowserWindow

    expect(() =>
      manager.executeApplicationMenuItem(
        {
          itemId: MenuItemIds.TaskPause,
          revision: initialRevision,
          trigger: 'menu',
          selectedTaskId: null,
        },
        targetWindow
      )
    ).toThrow('cannot be executed')

    contextStore.merge({ selectedTaskId: 'task-1' })
    const enabledRevision = manager.getApplicationMenuSnapshot().revision
    manager.executeApplicationMenuItem(
      {
        itemId: MenuItemIds.TaskPause,
        revision: enabledRevision,
        trigger: 'menu',
        selectedTaskId: 'task-1',
      },
      targetWindow
    )
    await Promise.resolve()
    expect(protectedRun).toHaveBeenCalledOnce()

    contextStore.merge({ selectedTaskId: 'task-2' })
    expect(() =>
      manager.executeApplicationMenuItem(
        {
          itemId: MenuItemIds.TaskPause,
          revision: manager.getApplicationMenuSnapshot().revision,
          trigger: 'menu',
          selectedTaskId: 'task-1',
        },
        targetWindow
      )
    ).toThrow('command context is stale')

    contextStore.merge({ selectedTaskId: null })
    expect(() =>
      manager.executeApplicationMenuItem(
        {
          itemId: MenuItemIds.TaskPause,
          revision: enabledRevision,
          trigger: 'menu',
          selectedTaskId: 'task-1',
        },
        targetWindow
      )
    ).toThrow('stale')

    const currentRevision = manager.getApplicationMenuSnapshot().revision
    for (const itemId of [
      'missing',
      MenuIds.MenubarTask,
      'menubar.file.nested',
      MenuItemIds.ApplicationSubmenusSeparator,
      MenuItemIds.ApplicationQuitSeparator,
      MenuItemIds.HelpWebsite,
    ]) {
      expect(() =>
        manager.executeApplicationMenuItem(
          {
            itemId,
            revision: currentRevision,
            trigger: 'menu',
            selectedTaskId: null,
          },
          targetWindow
        )
      ).toThrow('cannot be executed')
    }
    expect(hiddenRun).not.toHaveBeenCalled()
    expect(nestedRun).not.toHaveBeenCalled()
  })

  it('invokes the current Electron role item with the target window', () => {
    const { manager } = createManager()
    manager.install()
    const targetWindow = { webContents: { id: 7 } } as Electron.BrowserWindow
    const revision = manager.getApplicationMenuSnapshot().revision

    manager.executeApplicationMenuItem(
      {
        itemId: MenuItemIds.WindowMinimize,
        revision,
        trigger: 'menu',
        selectedTaskId: null,
        modifiers: { alt: true, control: false, meta: false, shift: true },
      },
      targetWindow
    )

    expect(
      electronMenu.roleClicks.get(MenuItemIds.WindowMinimize)
    ).toHaveBeenCalledWith(
      {
        altKey: true,
        ctrlKey: false,
        metaKey: false,
        shiftKey: true,
        triggeredByAccelerator: false,
      },
      targetWindow,
      targetWindow.webContents
    )
  })

  it('captures the authorized task context before tracked work can be retargeted', async () => {
    const queuedOperations: Array<() => Promise<void>> = []
    const { manager, contextStore, protectedRun } = createManager({
      trackAsyncWork: (operation) => {
        queuedOperations.push(operation)
        return Promise.resolve()
      },
    })
    contextStore.merge({ selectedTaskId: 'task-a' })
    manager.install()
    const targetWindow = { webContents: {} } as Electron.BrowserWindow

    manager.executeApplicationMenuItem(
      {
        itemId: MenuItemIds.TaskPause,
        revision: manager.getApplicationMenuSnapshot().revision,
        trigger: 'menu',
        selectedTaskId: 'task-a',
      },
      targetWindow
    )
    expect(queuedOperations).toHaveLength(1)

    // Simulate another IPC operation already queued ahead of the accepted
    // command's microtask. The command must still operate on task-a.
    contextStore.merge({ selectedTaskId: 'task-b' })
    await queuedOperations[0]?.()

    expect(protectedRun).toHaveBeenCalledOnce()
    expect(protectedRun.mock.calls[0]?.[0].menuContext.selectedTaskId).toBe(
      'task-a'
    )
  })

  it('reevaluates and publishes after a native command item click settles', async () => {
    const { manager, setCompactMode, setOnAboutRun } = createManager()
    manager.install()
    const changed = vi.fn()
    manager.onApplicationMenuChanged(changed)
    const appMenu = electronMenu.applicationMenus.at(-1) as FakeMenu
    const windowRoot = appMenu.items.find(
      (item) => item.id === MenuIds.MenubarWindow
    )
    const compactItem = windowRoot?.submenu?.items.find(
      (item) => item.id === 'menubar.window.mode.compact'
    )

    setOnAboutRun(() => setCompactMode(false))
    changed.mockClear()
    ;(compactItem?.click as (() => void) | undefined)?.()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(changed).toHaveBeenCalled()
    const windowNode = manager
      .getApplicationMenuSnapshot()
      .items.find((item) => item.id === MenuIds.MenubarWindow)
    expect(
      windowNode?.children?.find(
        (item) => item.id === 'menubar.window.mode.comfortable'
      )
    ).toMatchObject({ checked: true })
  })

  it('selects only the radio whose predicate is true during reevaluation', () => {
    const { manager, setCompactMode } = createManager()
    manager.install()
    electronMenu.checkedAssignments.clear()

    setCompactMode(false)

    expect(
      electronMenu.checkedAssignments.get('menubar.window.mode.compact')
    ).toBeUndefined()
    expect(
      electronMenu.checkedAssignments.get('menubar.window.mode.comfortable')
    ).toEqual([true])
    expect(electronMenu.radioChecked.get('menubar.window.mode.compact')).toBe(
      false
    )
    expect(
      electronMenu.radioChecked.get('menubar.window.mode.comfortable')
    ).toBe(true)
  })
})
