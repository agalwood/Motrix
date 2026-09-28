import { DEFAULT_LOCALE } from '@shared/constants/locales'
import type { MenuContext } from '@shared/types/menu-context'

export const DEFAULT_MENU_CONTEXT: MenuContext = {
  platform: process.platform as MenuContext['platform'],
  locale: DEFAULT_LOCALE,
  selectedTaskIds: [],
  selectedTaskGeneration: 0,
  selectedCanPause: false,
  selectedCanResume: false,
  selectedCanRemove: false,
  selectedCanMove: false,
  selectedTaskId: null,
  selectedTaskStatus: null,
  selectedTaskAtTop: false,
  selectedTaskAtBottom: false,
  taskSelected: false,
  hasAnyActiveTask: false,
  hasAnyPausedTask: false,
  hasStoppedTasks: false,
  currentRoute: '/downloads',
}
