import { CommandIds } from '@shared/commands-catalog'
import { MenuIds, MenuItemIds } from '../menu-ids'
import type { MenuRegistry } from '../menu-registry'

export function contributeTrayMenu(menuReg: MenuRegistry): void {
  menuReg.appendItem({
    id: MenuItemIds.TrayNew,
    type: 'normal',
    menuId: MenuIds.Tray,
    group: '1_new',
    order: 10,
    commandId: CommandIds.TaskNew,
  })
  menuReg.appendItem({
    id: MenuItemIds.TrayNewBt,
    type: 'normal',
    menuId: MenuIds.Tray,
    group: '1_new',
    order: 20,
    commandId: CommandIds.TaskNewBt,
  })
  menuReg.appendItem({
    id: MenuItemIds.TrayOpenFile,
    type: 'normal',
    menuId: MenuIds.Tray,
    group: '1_new',
    order: 30,
    commandId: CommandIds.TaskOpenFile,
  })
  menuReg.appendItem({
    id: MenuItemIds.TrayShow,
    type: 'normal',
    menuId: MenuIds.Tray,
    group: '2_window',
    order: 10,
    commandId: CommandIds.AppShowMain,
  })
  menuReg.appendItem({
    id: MenuItemIds.TrayManual,
    type: 'normal',
    menuId: MenuIds.Tray,
    group: '2_window',
    order: 20,
    commandId: CommandIds.HelpOpenManual,
  })
  menuReg.appendItem({
    id: MenuItemIds.TrayCheckForUpdates,
    type: 'normal',
    menuId: MenuIds.Tray,
    group: '2_window',
    order: 30,
    commandId: CommandIds.AppCheckForUpdates,
  })
  menuReg.appendItem({
    id: MenuItemIds.TrayPreferences,
    type: 'normal',
    menuId: MenuIds.Tray,
    group: '3_app',
    order: 10,
    commandId: CommandIds.AppOpenPreferences,
  })
  menuReg.appendItem({
    id: MenuItemIds.TrayQuit,
    type: 'normal',
    menuId: MenuIds.Tray,
    group: '9_quit',
    order: 10,
    role: 'quit',
    titleOverride: 'menu.app.quit',
  })
}
