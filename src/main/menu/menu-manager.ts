import type { CommandId } from '@shared/commands-catalog'
import type { MenuContext } from '@shared/types/menu-context'
import { Menu, type MenuItemConstructorOptions } from 'electron'
import type { CommandRegistry } from '../commands/command-registry'
import type { ContextStore } from '../commands/context-store'
import type { KeybindingRegistry } from '../commands/keybindings/keybinding-registry'
import type { CommandDeps } from '../commands/types'
import { i18n } from '../lib/i18n'
import { type MenuId, MenuIds } from './menu-ids'
import type { MenuRegistry } from './menu-registry'
import type { MenuItem } from './types'

export interface MenuManagerDeps {
  commandRegistry: CommandRegistry
  menuRegistry: MenuRegistry
  keybindingRegistry: KeybindingRegistry
  contextStore: ContextStore
  commandDeps: CommandDeps
  trackAsyncWork?: (operation: () => Promise<void>) => Promise<void>
  onCommandError?: (error: unknown) => void
}

function rootMenubarIds(platform: NodeJS.Platform): MenuId[] {
  const first = platform === 'darwin' ? MenuIds.MenubarApp : MenuIds.MenubarFile
  return [
    first,
    MenuIds.MenubarTask,
    MenuIds.MenubarEdit,
    MenuIds.MenubarWindow,
    MenuIds.MenubarHelp,
  ]
}

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

export class MenuManager {
  private appMenu: Menu | null = null
  private trayMenu: Menu | null = null
  private itemsById = new Map<string, MenuItem>()
  private trayRebuiltListeners = new Set<(m: Menu) => void>()
  private disposables: Array<() => void> = []

  constructor(private deps: MenuManagerDeps) {}

  install(): void {
    this.rebuild()
    const offCtx = this.deps.contextStore.onChange(() => this.reevaluate())
    this.disposables.push(offCtx)
    const onLang = (): void => this.rebuild()
    i18n.on('languageChanged', onLang)
    this.disposables.push(() => i18n.off('languageChanged', onLang))
  }

  dispose(): void {
    this.disable()
    for (const off of this.disposables) off()
    this.disposables = []
    this.appMenu = null
    this.trayMenu = null
    this.itemsById.clear()
    this.trayRebuiltListeners.clear()
  }

  disable(): void {
    Menu.setApplicationMenu(null)
    this.appMenu = null
    if (this.trayMenu) this.disableItems(this.trayMenu)
  }

  getTrayMenu(): Menu | null {
    return this.trayMenu
  }

  onTrayRebuilt(fn: (m: Menu) => void): () => void {
    this.trayRebuiltListeners.add(fn)
    return () => {
      this.trayRebuiltListeners.delete(fn)
    }
  }

  private rebuild(): void {
    this.itemsById.clear()
    this.buildAppMenu()
    this.buildTrayMenu()
    this.notifyTrayRebuilt()
  }

  private buildAppMenu(): void {
    const platform = this.deps.contextStore.get().platform
    const template: MenuItemConstructorOptions[] = rootMenubarIds(platform).map(
      (rootId) => ({
        label: i18n.t(rootMenubarLabelKey(rootId)),
        submenu: this.buildSubmenu(rootId),
      })
    )
    this.appMenu = Menu.buildFromTemplate(template)
    Menu.setApplicationMenu(this.appMenu)
  }

  private buildTrayMenu(): void {
    const template = this.buildSubmenu(MenuIds.Tray)
    this.trayMenu = Menu.buildFromTemplate(template)
  }

  private buildSubmenu(menuId: MenuId): MenuItemConstructorOptions[] {
    const items = this.deps.menuRegistry.getItems(menuId)
    const template: MenuItemConstructorOptions[] = []
    let lastGroup: string | null = null
    for (const item of items) {
      if (lastGroup !== null && item.group !== lastGroup) {
        template.push({ type: 'separator' })
      }
      lastGroup = item.group
      const entry = this.toTemplateEntry(item)
      if (entry) template.push(entry)
    }
    return template
  }

  private toTemplateEntry(
    item: MenuItem
  ): MenuItemConstructorOptions | undefined {
    const id = item.commandId ?? item.titleOverride ?? item.role
    if (id) this.itemsById.set(id, item)
    const label = this.resolveLabel(item)

    if (item.submenu) {
      return { id, label, submenu: this.buildSubmenu(item.submenu) }
    }
    if (item.role) {
      return { id, label, role: item.role }
    }
    if (item.commandId) {
      const accelerator = this.deps.keybindingRegistry.forCommand(
        item.commandId as CommandId
      )
      return {
        id: item.commandId,
        label,
        accelerator,
        click: () => {
          const execute = () =>
            this.deps.commandRegistry.execute(
              item.commandId as string,
              undefined,
              {
                menuContext: this.deps.contextStore.get(),
                deps: this.deps.commandDeps,
              }
            )
          const execution = this.deps.trackAsyncWork
            ? this.deps.trackAsyncWork(execute)
            : execute()
          void execution.catch((error) => this.deps.onCommandError?.(error))
        },
      }
    }
    return undefined
  }

  private resolveLabel(item: MenuItem): string {
    if (item.titleOverride) return i18n.t(item.titleOverride)
    if (item.commandId) {
      const cmd = this.deps.commandRegistry.get(item.commandId)
      return cmd ? i18n.t(cmd.title) : item.commandId
    }
    return ''
  }

  private reevaluate(): void {
    const ctx = this.deps.contextStore.get()
    if (this.appMenu) this.walkAndUpdate(this.appMenu, ctx)
    if (this.trayMenu) this.walkAndUpdate(this.trayMenu, ctx)
  }

  private walkAndUpdate(menu: Menu, ctx: Readonly<MenuContext>): void {
    for (const item of menu.items) {
      this.updateElectronItem(item, ctx)
      if (item.submenu) this.walkAndUpdate(item.submenu, ctx)
    }
  }

  private disableItems(menu: Menu): void {
    for (const item of menu.items) {
      item.enabled = false
      if (item.submenu) this.disableItems(item.submenu)
    }
  }

  private updateElectronItem(
    electronItem: Electron.MenuItem,
    ctx: Readonly<MenuContext>
  ): void {
    if (!electronItem.id) return
    const meta = this.itemsById.get(electronItem.id)
    if (!meta) return
    if (meta.when) electronItem.visible = meta.when(ctx)
    if (meta.commandId) {
      electronItem.enabled = this.deps.commandRegistry.canExecute(
        meta.commandId,
        ctx
      )
    }
    if (meta.toggled) electronItem.checked = meta.toggled(ctx)
  }

  private notifyTrayRebuilt(): void {
    if (!this.trayMenu) return
    for (const fn of this.trayRebuiltListeners) fn(this.trayMenu)
  }
}
