import { CommandIds } from '@shared/commands-catalog'
import { MenuIds } from '../menu-ids'
import type { MenuRegistry } from '../menu-registry'

export function contributeDarwinMenubar(menuReg: MenuRegistry): void {
  menuReg.appendItem({
    menuId: MenuIds.MenubarApp,
    group: '1_about',
    order: 10,
    commandId: CommandIds.AppShowAbout,
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarApp,
    group: '2_prefs',
    order: 10,
    commandId: CommandIds.AppOpenPreferences,
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarApp,
    group: '2_prefs',
    order: 20,
    commandId: CommandIds.AppCheckForUpdates,
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarApp,
    group: '3_hide',
    order: 10,
    role: 'hide',
    titleOverride: 'menu.app.hide',
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarApp,
    group: '3_hide',
    order: 20,
    role: 'hideOthers',
    titleOverride: 'menu.app.hideOthers',
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarApp,
    group: '3_hide',
    order: 30,
    role: 'unhide',
    titleOverride: 'menu.app.unhide',
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarApp,
    group: '9_quit',
    order: 10,
    role: 'quit',
    titleOverride: 'menu.app.quit',
  })

  // macOS-only Window menu extras
  menuReg.appendItem({
    menuId: MenuIds.MenubarWindow,
    group: '1_basic',
    order: 40,
    role: 'zoom',
    titleOverride: 'menu.window.zoom',
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarWindow,
    group: '2_front',
    order: 10,
    role: 'front',
    titleOverride: 'menu.window.front',
  })
}
