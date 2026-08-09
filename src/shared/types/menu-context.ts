import type { SupportedLocale } from '../constants/locales'
import type { TaskStatus } from './task'

/**
 * Runtime state consumed by menu when-clauses and command preconditions.
 * Field names are domain-level only — never aria2 raw strings or gid.
 *
 * Any field added here must also be added to:
 *   - DEFAULT_MENU_CONTEXT in src/main/commands/menu-context.ts
 *   - MenuContextPatchSchema in src/main/commands/context-schema.ts
 *   - useMenuContextSync payload computation in the renderer
 */
export interface MenuContext {
  platform: 'darwin' | 'win32' | 'linux'
  locale: SupportedLocale

  // Selected task
  selectedTaskId: string | null
  selectedTaskStatus: TaskStatus | null
  selectedTaskAtTop: boolean
  selectedTaskAtBottom: boolean
  /** Derived: selectedTaskId !== null. Computed inside ContextStore.merge. */
  taskSelected: boolean

  // Aggregate list state
  hasAnyActiveTask: boolean
  hasAnyPausedTask: boolean
  hasStoppedTasks: boolean

  // Navigation
  currentRoute: string
}
