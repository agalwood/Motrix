import { PRODUCT_MENU_ITEMS } from '@shared/application-menu-catalog'
import { MenuIds, MenuItemIds } from '../menu-ids'
import type { MenuRegistry } from '../menu-registry'

export function contributeSharedMenubar(menuReg: MenuRegistry): void {
  for (const item of PRODUCT_MENU_ITEMS) {
    if (item.section === 'app') continue
    menuReg.appendItem({
      id: item.id,
      type: 'normal',
      menuId:
        item.section === 'task' ? MenuIds.MenubarTask : MenuIds.MenubarHelp,
      group: item.group,
      order: item.order,
      commandId: item.commandId,
      ...(item.scope === 'selection'
        ? { contextBinding: 'selectedTask' as const }
        : {}),
    })
  }

  // Edit menu (all roles)
  menuReg.appendItem({
    id: MenuItemIds.EditUndo,
    type: 'normal',
    menuId: MenuIds.MenubarEdit,
    group: '1_undo',
    order: 10,
    role: 'undo',
    titleOverride: 'menu.edit.undo',
  })
  menuReg.appendItem({
    id: MenuItemIds.EditRedo,
    type: 'normal',
    menuId: MenuIds.MenubarEdit,
    group: '1_undo',
    order: 20,
    role: 'redo',
    titleOverride: 'menu.edit.redo',
  })
  menuReg.appendItem({
    id: MenuItemIds.EditCut,
    type: 'normal',
    menuId: MenuIds.MenubarEdit,
    group: '2_clipboard',
    order: 10,
    role: 'cut',
    titleOverride: 'menu.edit.cut',
  })
  menuReg.appendItem({
    id: MenuItemIds.EditCopy,
    type: 'normal',
    menuId: MenuIds.MenubarEdit,
    group: '2_clipboard',
    order: 20,
    role: 'copy',
    titleOverride: 'menu.edit.copy',
  })
  menuReg.appendItem({
    id: MenuItemIds.EditPaste,
    type: 'normal',
    menuId: MenuIds.MenubarEdit,
    group: '2_clipboard',
    order: 30,
    role: 'paste',
    titleOverride: 'menu.edit.paste',
  })
  menuReg.appendItem({
    id: MenuItemIds.EditDelete,
    type: 'normal',
    menuId: MenuIds.MenubarEdit,
    group: '2_clipboard',
    order: 40,
    role: 'delete',
    titleOverride: 'menu.edit.delete',
  })
  menuReg.appendItem({
    id: MenuItemIds.EditSelectAll,
    type: 'normal',
    menuId: MenuIds.MenubarEdit,
    group: '3_select',
    order: 10,
    role: 'selectAll',
    titleOverride: 'menu.edit.selectAll',
  })

  // Window menu (baseline — darwin adds zoom/front separately)
  menuReg.appendItem({
    id: MenuItemIds.WindowReload,
    type: 'normal',
    menuId: MenuIds.MenubarWindow,
    group: '1_basic',
    order: 10,
    role: 'reload',
    titleOverride: 'menu.window.reload',
  })
  menuReg.appendItem({
    id: MenuItemIds.WindowClose,
    type: 'normal',
    menuId: MenuIds.MenubarWindow,
    group: '1_basic',
    order: 20,
    role: 'close',
    titleOverride: 'menu.window.close',
  })
  menuReg.appendItem({
    id: MenuItemIds.WindowMinimize,
    type: 'normal',
    menuId: MenuIds.MenubarWindow,
    group: '1_basic',
    order: 30,
    role: 'minimize',
    titleOverride: 'menu.window.minimize',
  })
  menuReg.appendItem({
    id: MenuItemIds.WindowToggleFullscreen,
    type: 'normal',
    menuId: MenuIds.MenubarWindow,
    group: '1_basic',
    order: 50,
    role: 'togglefullscreen',
    visible: false,
  })

  menuReg.appendItem({
    id: MenuItemIds.HelpToggleDevTools,
    type: 'normal',
    menuId: MenuIds.MenubarHelp,
    group: '3_dev',
    order: 10,
    role: 'toggleDevTools',
    titleOverride: 'menu.help.toggleDevTools',
  })
}
