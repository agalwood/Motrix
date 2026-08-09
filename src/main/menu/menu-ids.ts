export const MenuIds = {
  MenubarApp: 'menubar.app',
  MenubarFile: 'menubar.file',
  MenubarTask: 'menubar.task',
  MenubarEdit: 'menubar.edit',
  MenubarWindow: 'menubar.window',
  MenubarHelp: 'menubar.help',
  Tray: 'tray.main',
} as const

export type MenuId = (typeof MenuIds)[keyof typeof MenuIds]
