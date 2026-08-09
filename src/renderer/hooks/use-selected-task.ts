import type { DownloadTask } from '@shared/types/task'

export interface SelectedTaskSnapshot {
  task: DownloadTask | null
  atTop: boolean
  atBottom: boolean
}

const NONE: SelectedTaskSnapshot = {
  task: null,
  atTop: false,
  atBottom: false,
}

/**
 * Returns the currently-selected download task.
 * Today the renderer has no task-list UI or selection store, so this
 * always returns the "none" snapshot. Wire the real selection source
 * in (or alongside) the download-list UI work; when done, this hook's
 * contract (task + atTop + atBottom) is what useMenuContextSync consumes.
 */
export function useSelectedTask(): SelectedTaskSnapshot {
  return NONE
}
