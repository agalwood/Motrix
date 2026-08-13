import { CommandIds } from '@shared/commands-catalog'
import { MenuIds, MenuItemIds } from '../menu-ids'
import type { MenuRegistry } from '../menu-registry'

// Used by both Windows and Linux.
export function contributeWin32Menubar(menuReg: MenuRegistry): void {
  menuReg.appendItem({
    id: MenuItemIds.AppShow,
    type: 'normal',
    menuId: MenuIds.MenubarApp,
    group: '9_quit',
    order: 5,
    commandId: CommandIds.AppShowMain,
    visible: false,
    platforms: ['win32', 'linux'],
    includeInApplicationMenu: false,
  })
}
