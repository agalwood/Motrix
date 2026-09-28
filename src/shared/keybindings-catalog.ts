import { type CommandId, CommandIds } from './commands-catalog'

export interface KeybindingEntry {
  /** Electron accelerator syntax, e.g. 'CommandOrControl+N'. */
  accelerator: string

  /**
   * Web-shell override.
   * - undefined: same as `accelerator`.
   * - string: use this instead (browser-safe alternative).
   * - null: unavailable in web shell (browser reserves key, no web semantics,
   *   or depends on desktop-only feature).
   */
  webAccelerator?: string | null

  commandId: CommandId
}

export const DEFAULT_KEYBINDINGS: readonly KeybindingEntry[] = [
  {
    accelerator: 'CommandOrControl+Q',
    commandId: CommandIds.AppQuit,
    webAccelerator: null,
  },
  {
    accelerator: 'CommandOrControl+,',
    commandId: CommandIds.AppOpenPreferences,
    webAccelerator: null,
  },
  {
    accelerator: 'CommandOrControl+N',
    commandId: CommandIds.TaskNew,
    webAccelerator: null,
  },
  {
    accelerator: 'CommandOrControl+Shift+N',
    commandId: CommandIds.TaskNewBt,
    webAccelerator: null,
  },
  {
    accelerator: 'CommandOrControl+O',
    commandId: CommandIds.TaskOpenFile,
    webAccelerator: null,
  },
  {
    accelerator: 'CommandOrControl+L',
    commandId: CommandIds.NavigateTaskList,
    webAccelerator: null,
  },
  {
    accelerator: 'CommandOrControl+Shift+P',
    commandId: CommandIds.TaskPauseAll,
    webAccelerator: null,
  },
  {
    accelerator: 'CommandOrControl+Shift+R',
    commandId: CommandIds.TaskResumeAll,
    webAccelerator: null,
  },
  {
    accelerator: 'CommandOrControl+M',
    commandId: CommandIds.AppShowMain,
    webAccelerator: null,
  },
]
