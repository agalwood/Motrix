import { MenuIds, MenuItemIds } from '../menu-ids'
import type { MenuRegistry } from '../menu-registry'

export function contributeDarwinMenubar(menuReg: MenuRegistry): void {
  menuReg.appendItem({
    id: MenuItemIds.AppHide,
    type: 'normal',
    menuId: MenuIds.MenubarApp,
    group: '3_hide',
    order: 10,
    role: 'hide',
    titleOverride: 'menu.app.hide',
    platforms: ['darwin'],
    includeInApplicationMenu: false,
  })
  menuReg.appendItem({
    id: MenuItemIds.AppHideOthers,
    type: 'normal',
    menuId: MenuIds.MenubarApp,
    group: '3_hide',
    order: 20,
    role: 'hideOthers',
    titleOverride: 'menu.app.hideOthers',
    platforms: ['darwin'],
    includeInApplicationMenu: false,
  })
  menuReg.appendItem({
    id: MenuItemIds.AppUnhide,
    type: 'normal',
    menuId: MenuIds.MenubarApp,
    group: '3_hide',
    order: 30,
    role: 'unhide',
    titleOverride: 'menu.app.unhide',
    platforms: ['darwin'],
    includeInApplicationMenu: false,
  })

  // macOS-only Window menu extras
  menuReg.appendItem({
    id: MenuItemIds.WindowZoom,
    type: 'normal',
    menuId: MenuIds.MenubarWindow,
    group: '1_basic',
    order: 40,
    role: 'zoom',
    titleOverride: 'menu.window.zoom',
    platforms: ['darwin'],
  })
  menuReg.appendItem({
    id: MenuItemIds.WindowFront,
    type: 'normal',
    menuId: MenuIds.MenubarWindow,
    group: '2_front',
    order: 10,
    role: 'front',
    titleOverride: 'menu.window.front',
    platforms: ['darwin'],
  })
}
