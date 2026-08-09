import { CommandIds } from '@shared/commands-catalog'
import { MenuIds } from '../menu-ids'
import type { MenuRegistry } from '../menu-registry'

export function contributeTrayMenu(menuReg: MenuRegistry): void {
  menuReg.appendItem({
    menuId: MenuIds.Tray,
    group: '1_new',
    order: 10,
    commandId: CommandIds.TaskNew,
  })
  menuReg.appendItem({
    menuId: MenuIds.Tray,
    group: '1_new',
    order: 20,
    commandId: CommandIds.TaskNewBt,
  })
  menuReg.appendItem({
    menuId: MenuIds.Tray,
    group: '1_new',
    order: 30,
    commandId: CommandIds.TaskOpenFile,
  })
  menuReg.appendItem({
    menuId: MenuIds.Tray,
    group: '2_window',
    order: 10,
    commandId: CommandIds.AppShowMain,
  })
  menuReg.appendItem({
    menuId: MenuIds.Tray,
    group: '2_window',
    order: 20,
    commandId: CommandIds.HelpOpenManual,
  })
  menuReg.appendItem({
    menuId: MenuIds.Tray,
    group: '2_window',
    order: 30,
    commandId: CommandIds.AppCheckForUpdates,
  })
  menuReg.appendItem({
    menuId: MenuIds.Tray,
    group: '3_app',
    order: 10,
    commandId: CommandIds.AppOpenPreferences,
  })
  menuReg.appendItem({
    menuId: MenuIds.Tray,
    group: '9_quit',
    order: 10,
    role: 'quit',
    titleOverride: 'menu.app.quit',
  })
}
