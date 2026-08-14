import { CommandIds } from '@shared/commands-catalog'
import { MenuIds, MenuItemIds } from '../menu-ids'
import type { MenuRegistry } from '../menu-registry'

export function contributeSharedMenubar(menuReg: MenuRegistry): void {
  // Task menu
  menuReg.appendItem({
    id: MenuItemIds.TaskNew,
    type: 'normal',
    menuId: MenuIds.MenubarTask,
    group: '1_new',
    order: 10,
    commandId: CommandIds.TaskNew,
  })
  menuReg.appendItem({
    id: MenuItemIds.TaskNewBt,
    type: 'normal',
    menuId: MenuIds.MenubarTask,
    group: '1_new',
    order: 20,
    commandId: CommandIds.TaskNewBt,
  })
  menuReg.appendItem({
    id: MenuItemIds.TaskOpenFile,
    type: 'normal',
    menuId: MenuIds.MenubarTask,
    group: '1_new',
    order: 30,
    commandId: CommandIds.TaskOpenFile,
  })
  menuReg.appendItem({
    id: MenuItemIds.TaskList,
    type: 'normal',
    menuId: MenuIds.MenubarTask,
    group: '2_primary',
    order: 10,
    commandId: CommandIds.NavigateTaskList,
  })
  menuReg.appendItem({
    id: MenuItemIds.TaskPause,
    type: 'normal',
    menuId: MenuIds.MenubarTask,
    group: '2_primary',
    order: 20,
    commandId: CommandIds.TaskPause,
    contextBinding: 'selectedTask',
  })
  menuReg.appendItem({
    id: MenuItemIds.TaskResume,
    type: 'normal',
    menuId: MenuIds.MenubarTask,
    group: '2_primary',
    order: 30,
    commandId: CommandIds.TaskResume,
    contextBinding: 'selectedTask',
  })
  menuReg.appendItem({
    id: MenuItemIds.TaskDelete,
    type: 'normal',
    menuId: MenuIds.MenubarTask,
    group: '2_primary',
    order: 40,
    commandId: CommandIds.TaskDelete,
    contextBinding: 'selectedTask',
  })
  menuReg.appendItem({
    id: MenuItemIds.TaskMoveUp,
    type: 'normal',
    menuId: MenuIds.MenubarTask,
    group: '2_primary',
    order: 50,
    commandId: CommandIds.TaskMoveUp,
    contextBinding: 'selectedTask',
  })
  menuReg.appendItem({
    id: MenuItemIds.TaskMoveDown,
    type: 'normal',
    menuId: MenuIds.MenubarTask,
    group: '2_primary',
    order: 60,
    commandId: CommandIds.TaskMoveDown,
    contextBinding: 'selectedTask',
  })
  menuReg.appendItem({
    id: MenuItemIds.TaskPauseAll,
    type: 'normal',
    menuId: MenuIds.MenubarTask,
    group: '3_bulk',
    order: 10,
    commandId: CommandIds.TaskPauseAll,
  })
  menuReg.appendItem({
    id: MenuItemIds.TaskResumeAll,
    type: 'normal',
    menuId: MenuIds.MenubarTask,
    group: '3_bulk',
    order: 20,
    commandId: CommandIds.TaskResumeAll,
  })
  menuReg.appendItem({
    id: MenuItemIds.TaskSelectAll,
    type: 'normal',
    menuId: MenuIds.MenubarTask,
    group: '3_bulk',
    order: 30,
    role: 'selectAll',
    titleOverride: 'menu.task.selectAllTask',
  })
  menuReg.appendItem({
    id: MenuItemIds.TaskClearStopped,
    type: 'normal',
    menuId: MenuIds.MenubarTask,
    group: '4_clear',
    order: 10,
    commandId: CommandIds.TaskClearStopped,
  })

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
    titleOverride: 'menu.window.toggleFullscreen',
  })

  // Help menu
  menuReg.appendItem({
    id: MenuItemIds.HelpWebsite,
    type: 'normal',
    menuId: MenuIds.MenubarHelp,
    group: '1_links',
    order: 10,
    commandId: CommandIds.HelpOpenWebsite,
  })
  menuReg.appendItem({
    id: MenuItemIds.HelpManual,
    type: 'normal',
    menuId: MenuIds.MenubarHelp,
    group: '1_links',
    order: 20,
    commandId: CommandIds.HelpOpenManual,
  })
  menuReg.appendItem({
    id: MenuItemIds.HelpChangelog,
    type: 'normal',
    menuId: MenuIds.MenubarHelp,
    group: '1_links',
    order: 30,
    commandId: CommandIds.HelpOpenChangelog,
  })
  menuReg.appendItem({
    id: MenuItemIds.HelpReportProblem,
    type: 'normal',
    menuId: MenuIds.MenubarHelp,
    group: '2_report',
    order: 10,
    commandId: CommandIds.HelpReportProblem,
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
