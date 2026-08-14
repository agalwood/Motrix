import type { CommandId } from '@shared/commands-catalog'
import type {
  ApplicationMenuNode,
  ApplicationMenuSnapshot,
  ExecuteApplicationMenuItemRequest,
} from '@shared/schemas/application-menu'
import { applicationMenuSnapshotSchema } from '@shared/schemas/application-menu'
import type { MenuContext } from '@shared/types/menu-context'
import {
  type BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
} from 'electron'
import type { CommandRegistry } from '../commands/command-registry'
import type { ContextStore } from '../commands/context-store'
import type { KeybindingRegistry } from '../commands/keybindings/keybinding-registry'
import type { CommandDeps } from '../commands/types'
import { i18n } from '../lib/i18n'
import { type MenuId, MenuIds, MenuItemIds } from './menu-ids'
import type { MenuRegistry } from './menu-registry'
import type { MenuItem, MenuPlatform } from './types'

export interface MenuManagerDeps {
  commandRegistry: CommandRegistry
  menuRegistry: MenuRegistry
  keybindingRegistry: KeybindingRegistry
  contextStore: ContextStore
  commandDeps: CommandDeps
  trackAsyncWork?: (operation: () => Promise<void>) => Promise<void>
  onCommandError?: (error: unknown) => void
  onApplicationMenuSet?: () => void
}

const ROOT_MENUBAR_IDS: readonly MenuId[] = [
  MenuIds.MenubarApp,
  MenuIds.MenubarTask,
  MenuIds.MenubarEdit,
  MenuIds.MenubarWindow,
  MenuIds.MenubarHelp,
]

const DROPDOWN_SUBMENU_IDS: readonly MenuId[] = [
  MenuIds.MenubarTask,
  MenuIds.MenubarEdit,
  MenuIds.MenubarWindow,
  MenuIds.MenubarHelp,
]

function rootMenubarLabelKey(menuId: MenuId): string {
  switch (menuId) {
    case MenuIds.MenubarApp:
      return 'menu.app.title'
    case MenuIds.MenubarFile:
      return 'menu.file.title'
    case MenuIds.MenubarTask:
      return 'menu.task.title'
    case MenuIds.MenubarEdit:
      return 'menu.edit.title'
    case MenuIds.MenubarWindow:
      return 'menu.window.title'
    case MenuIds.MenubarHelp:
      return 'menu.help.title'
    default:
      return menuId
  }
}

function separatorId(menuId: MenuId, followingGroup: string): string {
  return `separator:${menuId}:${followingGroup}`
}

function toMenuPlatform(platform: MenuContext['platform']): MenuPlatform {
  return platform
}

export class MenuManager {
  private appMenu: Menu | null = null
  private trayMenu: Menu | null = null
  private itemsById = new Map<string, MenuItem>()
  private applicationItemParentIds = new Map<string, string | null>()
  private applicationItemsById = new Map<string, Electron.MenuItem>()
  private trayRebuiltListeners = new Set<(menu: Menu) => void>()
  private applicationMenuChangedListeners = new Set<
    (snapshot: ApplicationMenuSnapshot) => void
  >()
  private disposables: Array<() => void> = []
  private applicationMenuSnapshot: ApplicationMenuSnapshot = {
    revision: 0,
    items: [],
  }
  private applicationMenuSemantic = JSON.stringify([])
  private enabled = false

  constructor(private deps: MenuManagerDeps) {}

  install(): void {
    this.enabled = true
    this.rebuild()
    const offContext = this.deps.contextStore.onChange(() => this.reevaluate())
    this.disposables.push(offContext)
    const onLanguageChanged = (): void => this.rebuild()
    i18n.on('languageChanged', onLanguageChanged)
    this.disposables.push(() => i18n.off('languageChanged', onLanguageChanged))
  }

  dispose(): void {
    this.disable()
    for (const dispose of this.disposables) dispose()
    this.disposables = []
    this.appMenu = null
    this.trayMenu = null
    this.itemsById.clear()
    this.applicationItemParentIds.clear()
    this.applicationItemsById.clear()
    this.trayRebuiltListeners.clear()
    this.applicationMenuChangedListeners.clear()
  }

  disable(): void {
    this.enabled = false
    Menu.setApplicationMenu(null)
    if (this.appMenu) this.disableItems(this.appMenu)
    if (this.trayMenu) this.disableItems(this.trayMenu)
    this.appMenu = null
    this.applicationItemsById.clear()
    this.applicationItemParentIds.clear()
  }

  getTrayMenu(): Menu | null {
    return this.trayMenu
  }

  onTrayRebuilt(listener: (menu: Menu) => void): () => void {
    this.trayRebuiltListeners.add(listener)
    return () => {
      this.trayRebuiltListeners.delete(listener)
    }
  }

  getApplicationMenuSnapshot(): ApplicationMenuSnapshot {
    return applicationMenuSnapshotSchema.parse(this.applicationMenuSnapshot)
  }

  onApplicationMenuChanged(
    listener: (snapshot: ApplicationMenuSnapshot) => void
  ): () => void {
    this.applicationMenuChangedListeners.add(listener)
    return () => {
      this.applicationMenuChangedListeners.delete(listener)
    }
  }

  executeApplicationMenuItem(
    request: ExecuteApplicationMenuItemRequest,
    targetWindow: BrowserWindow
  ): void {
    if (!this.enabled || !this.appMenu) {
      throw new Error('Application menu is not available')
    }

    // Revalidate against the current context immediately before dispatch. The
    // renderer snapshot is an authorization hint, never the source of truth.
    this.reevaluate()
    if (request.revision !== this.applicationMenuSnapshot.revision) {
      throw new Error('Application menu snapshot is stale')
    }

    const item = this.applicationItemsById.get(request.itemId)
    const definition = this.itemsById.get(request.itemId)
    if (
      !item ||
      !definition ||
      definition.includeInApplicationMenu === false ||
      item.type === 'separator' ||
      item.submenu ||
      !item.enabled ||
      !item.visible ||
      typeof item.click !== 'function'
    ) {
      throw new Error('Application menu item cannot be executed')
    }
    let parentId = this.applicationItemParentIds.get(request.itemId)
    while (parentId) {
      const parent = this.applicationItemsById.get(parentId)
      const parentDefinition = this.itemsById.get(parentId)
      if (
        !parent?.visible ||
        parentDefinition?.includeInApplicationMenu === false
      ) {
        throw new Error('Application menu item cannot be executed')
      }
      parentId = this.applicationItemParentIds.get(parentId)
    }
    if (
      definition.contextBinding === 'selectedTask' &&
      request.selectedTaskId !== this.deps.contextStore.get().selectedTaskId
    ) {
      throw new Error('Application menu command context is stale')
    }

    const modifiers = request.modifiers
    item.click.call(
      item,
      {
        altKey: modifiers?.alt ?? false,
        ctrlKey: modifiers?.control ?? false,
        metaKey: modifiers?.meta ?? false,
        shiftKey: modifiers?.shift ?? false,
        triggeredByAccelerator: false,
      } satisfies Electron.KeyboardEvent,
      targetWindow,
      targetWindow.webContents
    )
    this.reevaluate()
  }

  private rebuild(): void {
    if (!this.enabled) return
    this.itemsById.clear()
    this.applicationItemsById.clear()
    this.applicationItemParentIds.clear()

    const platform = toMenuPlatform(this.deps.contextStore.get().platform)
    const applicationTemplate: MenuItemConstructorOptions[] =
      ROOT_MENUBAR_IDS.map((rootId) => ({
        id: rootId,
        type: 'submenu',
        label: i18n.t(rootMenubarLabelKey(rootId)),
        submenu: this.buildSubmenu(rootId, platform),
      }))

    this.appMenu = Menu.buildFromTemplate(applicationTemplate)
    this.trayMenu = Menu.buildFromTemplate(
      this.buildSubmenu(MenuIds.Tray, platform)
    )
    this.indexApplicationItems(this.appMenu)
    this.reevaluateMenus()
    Menu.setApplicationMenu(this.appMenu)
    this.deps.onApplicationMenuSet?.()
    this.publishApplicationMenuSnapshot()
    this.notifyTrayRebuilt()
  }

  private buildSubmenu(
    menuId: MenuId,
    platform: MenuPlatform
  ): MenuItemConstructorOptions[] {
    const items = this.deps.menuRegistry.getItems(menuId, platform)
    const template: MenuItemConstructorOptions[] = []
    let previousGroup: string | null = null
    for (const item of items) {
      if (previousGroup !== null && item.group !== previousGroup) {
        template.push({
          id: separatorId(menuId, item.group),
          type: 'separator',
        })
      }
      previousGroup = item.group
      this.itemsById.set(item.id, item)
      template.push(this.toTemplateEntry(item, platform))
    }
    return template
  }

  private toTemplateEntry(
    item: MenuItem,
    platform: MenuPlatform
  ): MenuItemConstructorOptions {
    const state = this.evaluateItem(item, this.deps.contextStore.get())
    const base: MenuItemConstructorOptions = {
      id: item.id,
      type: item.type,
      label: this.resolveLabel(item),
      enabled: state.enabled,
      visible: state.visible,
      checked: state.checked,
    }

    if (item.submenu) {
      return {
        ...base,
        type: 'submenu',
        submenu: this.buildSubmenu(item.submenu, platform),
      }
    }
    if (item.role) return { ...base, role: item.role }
    if (item.commandId) {
      return {
        ...base,
        accelerator: this.deps.keybindingRegistry.forCommand(
          item.commandId as CommandId
        ),
        click: () => {
          void this.executeCommand(item.commandId as string).finally(() => {
            if (!this.enabled) return
            this.reevaluate()
          })
        },
      }
    }
    return base
  }

  private executeCommand(commandId: string): Promise<void> {
    if (!this.enabled) return Promise.resolve()
    // AsyncWorkTracker intentionally defers accepted work to a microtask.
    // Capture the exact context authorized by this click before yielding so a
    // queued renderer context update cannot retarget a destructive command.
    const menuContext = { ...this.deps.contextStore.get() }
    const execute = () =>
      this.deps.commandRegistry.execute(commandId, undefined, {
        menuContext,
        deps: this.deps.commandDeps,
      })
    const execution = this.deps.trackAsyncWork
      ? this.deps.trackAsyncWork(execute)
      : execute()
    return execution.catch((error) => {
      this.deps.onCommandError?.(error)
    })
  }

  private evaluateItem(
    item: MenuItem,
    context: Readonly<MenuContext>
  ): { enabled: boolean; visible: boolean; checked: boolean } {
    return {
      enabled: item.commandId
        ? this.deps.commandRegistry.canExecute(item.commandId, context)
        : true,
      visible:
        item.visible !== false && (!item.when || item.when(context) === true),
      checked: item.toggled?.(context) ?? false,
    }
  }

  private resolveLabel(item: MenuItem): string {
    if (item.titleOverride) return i18n.t(item.titleOverride)
    if (item.commandId) {
      const command = this.deps.commandRegistry.get(item.commandId)
      return command ? i18n.t(command.title) : item.commandId
    }
    return ''
  }

  private reevaluate(): void {
    if (!this.enabled) return
    this.reevaluateMenus()
    this.publishApplicationMenuSnapshot()
  }

  private reevaluateMenus(): void {
    const context = this.deps.contextStore.get()
    if (this.appMenu) {
      this.walkAndUpdate(this.appMenu, context)
      this.normalizeElectronSeparators(this.appMenu)
    }
    if (this.trayMenu) {
      this.walkAndUpdate(this.trayMenu, context)
      this.normalizeElectronSeparators(this.trayMenu)
    }
  }

  private walkAndUpdate(menu: Menu, context: Readonly<MenuContext>): void {
    for (const item of menu.items) {
      const definition = this.itemsById.get(item.id)
      if (definition) {
        const state = this.evaluateItem(definition, context)
        item.enabled = state.enabled
        item.visible = state.visible
        if (definition.toggled && item.type === 'radio') {
          if (state.checked) item.checked = true
        } else if (definition.toggled) {
          item.checked = state.checked
        }
      }
      if (item.submenu) {
        this.walkAndUpdate(item.submenu, context)
        if (
          definition?.type === 'submenu' &&
          !item.submenu.items.some((child) => child.visible)
        ) {
          item.visible = false
        }
      }
    }
  }

  private normalizeElectronSeparators(menu: Menu): void {
    for (const item of menu.items) {
      if (item.submenu) this.normalizeElectronSeparators(item.submenu)
    }

    let hasVisibleItemSinceSeparator = false
    for (let index = 0; index < menu.items.length; index += 1) {
      const item = menu.items[index]
      if (!item) continue
      if (item.type !== 'separator') {
        if (item.visible) hasVisibleItemSinceSeparator = true
        continue
      }
      const hasVisibleItemAfter = menu.items
        .slice(index + 1)
        .some((candidate) =>
          candidate.type === 'separator' ? false : candidate.visible
        )
      item.visible = hasVisibleItemSinceSeparator && hasVisibleItemAfter
      if (item.visible) hasVisibleItemSinceSeparator = false
    }
  }

  private indexApplicationItems(
    menu: Menu,
    parentId: string | null = null
  ): void {
    for (const item of menu.items) {
      if (item.id) {
        this.applicationItemsById.set(item.id, item)
        this.applicationItemParentIds.set(item.id, parentId)
      }
      if (item.submenu) this.indexApplicationItems(item.submenu, item.id)
    }
  }

  private buildApplicationMenuItems(): ApplicationMenuNode[] {
    if (!this.appMenu) return []
    const appRoot = this.appMenu.items.find(
      (item) => item.id === MenuIds.MenubarApp
    )
    const appChildren = appRoot?.submenu?.items ?? []
    const primary = appChildren
      .filter(
        (item) =>
          item.type !== 'separator' &&
          item.id !== MenuItemIds.AppQuit &&
          this.itemsById.get(item.id)?.includeInApplicationMenu !== false
      )
      .map((item) => this.toSnapshotNode(item))

    const submenus = DROPDOWN_SUBMENU_IDS.map((menuId) =>
      this.appMenu?.items.find((item) => item.id === menuId)
    )
      .filter((item): item is Electron.MenuItem => Boolean(item))
      .map((item) => this.toSnapshotNode(item))

    const quitItem = appChildren.find((item) => item.id === MenuItemIds.AppQuit)
    const items: ApplicationMenuNode[] = [...primary]
    if (submenus.length > 0) {
      items.push({
        id: MenuItemIds.ApplicationSubmenusSeparator,
        type: 'separator',
        label: '',
        enabled: false,
        visible: true,
      })
      items.push(...submenus)
    }
    if (quitItem) {
      items.push({
        id: MenuItemIds.ApplicationQuitSeparator,
        type: 'separator',
        label: '',
        enabled: false,
        visible:
          quitItem.visible && items.some((candidate) => candidate.visible),
      })
      items.push(this.toSnapshotNode(quitItem))
    }
    return this.normalizeSnapshotTree(items)
  }

  private toSnapshotNode(item: Electron.MenuItem): ApplicationMenuNode {
    const definition = this.itemsById.get(item.id)
    const children = item.submenu?.items
      .filter(
        (child) =>
          this.itemsById.get(child.id)?.includeInApplicationMenu !== false
      )
      .map((child) => this.toSnapshotNode(child))
    const type =
      item.type === 'separator' ||
      item.type === 'submenu' ||
      item.type === 'checkbox' ||
      item.type === 'radio'
        ? item.type
        : 'normal'
    const node: ApplicationMenuNode = {
      id: item.id,
      type,
      label: item.label,
      enabled: item.enabled,
      visible: item.visible,
    }
    if (item.accelerator) node.accelerator = item.accelerator
    if (type === 'checkbox' || type === 'radio') node.checked = item.checked
    if (definition?.radioGroupId) node.radioGroupId = definition.radioGroupId
    if (children) node.children = this.normalizeSnapshotTree(children)
    return node
  }

  private normalizeSnapshotTree(
    input: ApplicationMenuNode[]
  ): ApplicationMenuNode[] {
    const items = input.map((item) => {
      if (!item.children) return item
      const children = this.normalizeSnapshotTree(item.children)
      return {
        ...item,
        children,
        visible: item.visible && children.some((child) => child.visible),
      }
    })
    let hasVisibleItemSinceSeparator = false
    return items.map((item, index) => {
      if (item.type !== 'separator') {
        if (item.visible) hasVisibleItemSinceSeparator = true
        return item
      }
      const hasVisibleItemAfter = items
        .slice(index + 1)
        .some(
          (candidate) => candidate.type !== 'separator' && candidate.visible
        )
      const visible =
        item.visible && hasVisibleItemSinceSeparator && hasVisibleItemAfter
      if (visible) hasVisibleItemSinceSeparator = false
      return { ...item, visible }
    })
  }

  private publishApplicationMenuSnapshot(): void {
    const items = this.buildApplicationMenuItems()
    const semantic = JSON.stringify(items)
    if (semantic === this.applicationMenuSemantic) return
    this.applicationMenuSemantic = semantic
    this.applicationMenuSnapshot = {
      revision: this.applicationMenuSnapshot.revision + 1,
      items,
    }
    const snapshot = this.getApplicationMenuSnapshot()
    for (const listener of this.applicationMenuChangedListeners) {
      listener(snapshot)
    }
  }

  private disableItems(menu: Menu): void {
    for (const item of menu.items) {
      item.enabled = false
      if (item.submenu) this.disableItems(item.submenu)
    }
  }

  private notifyTrayRebuilt(): void {
    if (!this.trayMenu) return
    for (const listener of this.trayRebuiltListeners) {
      listener(this.trayMenu)
    }
  }
}
