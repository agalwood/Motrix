import { CommandIds } from '@shared/commands-catalog'
import { MenuIds, MenuItemIds } from '../menu-ids'
import type { MenuRegistry } from '../menu-registry'

export function contributeApplicationMenubar(menuReg: MenuRegistry): void {
  menuReg.appendItem({
    id: MenuItemIds.AppAbout,
    type: 'normal',
    menuId: MenuIds.MenubarApp,
    group: '1_about',
    order: 10,
    commandId: CommandIds.AppShowAbout,
  })
  menuReg.appendItem({
    id: MenuItemIds.AppPreferences,
    type: 'normal',
    menuId: MenuIds.MenubarApp,
    group: '2_prefs',
    order: 10,
    commandId: CommandIds.AppOpenPreferences,
  })
  menuReg.appendItem({
    id: MenuItemIds.AppCheckForUpdates,
    type: 'normal',
    menuId: MenuIds.MenubarApp,
    group: '2_prefs',
    order: 20,
    commandId: CommandIds.AppCheckForUpdates,
  })
  menuReg.appendItem({
    id: MenuItemIds.AppQuit,
    type: 'normal',
    menuId: MenuIds.MenubarApp,
    group: '9_quit',
    order: 10,
    role: 'quit',
    titleOverride: 'menu.app.quit',
  })
}
