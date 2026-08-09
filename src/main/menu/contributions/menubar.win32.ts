import { CommandIds } from '@shared/commands-catalog'
import { MenuIds } from '../menu-ids'
import type { MenuRegistry } from '../menu-registry'

// Used by both Windows and Linux.
export function contributeWin32Menubar(menuReg: MenuRegistry): void {
  menuReg.appendItem({
    menuId: MenuIds.MenubarFile,
    group: '1_about',
    order: 10,
    commandId: CommandIds.AppShowAbout,
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarFile,
    group: '2_prefs',
    order: 10,
    commandId: CommandIds.AppOpenPreferences,
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarFile,
    group: '2_prefs',
    order: 20,
    commandId: CommandIds.AppCheckForUpdates,
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarFile,
    group: '3_show',
    order: 10,
    commandId: CommandIds.AppShowMain,
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarFile,
    group: '9_quit',
    order: 10,
    role: 'quit',
    titleOverride: 'menu.app.quit',
  })
}
