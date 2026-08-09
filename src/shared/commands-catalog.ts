/**
 * Application-level command identifiers.
 * Referenced from menus, keybindings, tray, renderer shortcut hook,
 * and (in the future) command palette / plugin contributions.
 *
 * Using reverse-DNS style: motrix.<domain>.<verb>.
 */
export const CommandIds = {
  // App
  AppShowAbout: 'motrix.app.showAbout',
  AppOpenPreferences: 'motrix.app.openPreferences',
  AppCheckForUpdates: 'motrix.app.checkForUpdates',
  AppShowMain: 'motrix.app.showMain',
  AppQuit: 'motrix.app.quit',

  // Task
  TaskNew: 'motrix.task.new',
  TaskNewBt: 'motrix.task.newBt',
  TaskOpenFile: 'motrix.task.openFile',
  TaskPause: 'motrix.task.pause',
  TaskResume: 'motrix.task.resume',
  TaskDelete: 'motrix.task.delete',
  TaskMoveUp: 'motrix.task.moveUp',
  TaskMoveDown: 'motrix.task.moveDown',
  TaskPauseAll: 'motrix.task.pauseAll',
  TaskResumeAll: 'motrix.task.resumeAll',
  TaskClearStopped: 'motrix.task.clearStopped',

  // Navigation
  NavigateTaskList: 'motrix.navigate.taskList',

  // Help
  HelpOpenWebsite: 'motrix.help.openWebsite',
  HelpOpenManual: 'motrix.help.openManual',
  HelpOpenChangelog: 'motrix.help.openChangelog',
  HelpReportProblem: 'motrix.help.reportProblem',
} as const

export type CommandId = (typeof CommandIds)[keyof typeof CommandIds]
