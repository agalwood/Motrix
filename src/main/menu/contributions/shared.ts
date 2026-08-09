import { CommandIds } from '@shared/commands-catalog'
import { MenuIds } from '../menu-ids'
import type { MenuRegistry } from '../menu-registry'

export function contributeSharedMenubar(menuReg: MenuRegistry): void {
  // Task menu
  menuReg.appendItem({
    menuId: MenuIds.MenubarTask,
    group: '1_new',
    order: 10,
    commandId: CommandIds.TaskNew,
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarTask,
    group: '1_new',
    order: 20,
    commandId: CommandIds.TaskNewBt,
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarTask,
    group: '1_new',
    order: 30,
    commandId: CommandIds.TaskOpenFile,
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarTask,
    group: '2_primary',
    order: 10,
    commandId: CommandIds.NavigateTaskList,
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarTask,
    group: '2_primary',
    order: 20,
    commandId: CommandIds.TaskPause,
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarTask,
    group: '2_primary',
    order: 30,
    commandId: CommandIds.TaskResume,
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarTask,
    group: '2_primary',
    order: 40,
    commandId: CommandIds.TaskDelete,
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarTask,
    group: '2_primary',
    order: 50,
    commandId: CommandIds.TaskMoveUp,
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarTask,
    group: '2_primary',
    order: 60,
    commandId: CommandIds.TaskMoveDown,
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarTask,
    group: '3_bulk',
    order: 10,
    commandId: CommandIds.TaskPauseAll,
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarTask,
    group: '3_bulk',
    order: 20,
    commandId: CommandIds.TaskResumeAll,
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarTask,
    group: '3_bulk',
    order: 30,
    role: 'selectAll',
    titleOverride: 'menu.task.selectAllTask',
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarTask,
    group: '4_clear',
    order: 10,
    commandId: CommandIds.TaskClearStopped,
  })

  // Edit menu (all roles)
  menuReg.appendItem({
    menuId: MenuIds.MenubarEdit,
    group: '1_undo',
    order: 10,
    role: 'undo',
    titleOverride: 'menu.edit.undo',
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarEdit,
    group: '1_undo',
    order: 20,
    role: 'redo',
    titleOverride: 'menu.edit.redo',
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarEdit,
    group: '2_clipboard',
    order: 10,
    role: 'cut',
    titleOverride: 'menu.edit.cut',
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarEdit,
    group: '2_clipboard',
    order: 20,
    role: 'copy',
    titleOverride: 'menu.edit.copy',
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarEdit,
    group: '2_clipboard',
    order: 30,
    role: 'paste',
    titleOverride: 'menu.edit.paste',
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarEdit,
    group: '2_clipboard',
    order: 40,
    role: 'delete',
    titleOverride: 'menu.edit.delete',
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarEdit,
    group: '3_select',
    order: 10,
    role: 'selectAll',
    titleOverride: 'menu.edit.selectAll',
  })

  // Window menu (baseline — darwin adds zoom/front separately)
  menuReg.appendItem({
    menuId: MenuIds.MenubarWindow,
    group: '1_basic',
    order: 10,
    role: 'reload',
    titleOverride: 'menu.window.reload',
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarWindow,
    group: '1_basic',
    order: 20,
    role: 'close',
    titleOverride: 'menu.window.close',
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarWindow,
    group: '1_basic',
    order: 30,
    role: 'minimize',
    titleOverride: 'menu.window.minimize',
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarWindow,
    group: '1_basic',
    order: 50,
    role: 'togglefullscreen',
    titleOverride: 'menu.window.toggleFullscreen',
  })

  // Help menu
  menuReg.appendItem({
    menuId: MenuIds.MenubarHelp,
    group: '1_links',
    order: 10,
    commandId: CommandIds.HelpOpenWebsite,
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarHelp,
    group: '1_links',
    order: 20,
    commandId: CommandIds.HelpOpenManual,
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarHelp,
    group: '1_links',
    order: 30,
    commandId: CommandIds.HelpOpenChangelog,
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarHelp,
    group: '2_report',
    order: 10,
    commandId: CommandIds.HelpReportProblem,
  })
  menuReg.appendItem({
    menuId: MenuIds.MenubarHelp,
    group: '3_dev',
    order: 10,
    role: 'toggleDevTools',
    titleOverride: 'menu.help.toggleDevTools',
  })
}
