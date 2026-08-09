import { createSelectionStore } from '@renderer/components/desktop-kit/selection/create-selection-store'
import type { DownloadTask } from '@shared/types/task'

/**
 * Module-level singleton selection store for the Downloads page.
 *
 * Shared between `TaskListPanel` (via `useSelectableList({ store })`,
 * Task 6) and `TaskInspectorDrawer` (which subscribes directly to derive
 * its open / single-vs-multi state from `selectedIds.size`).
 */
export const useDownloadsSelection = createSelectionStore<DownloadTask>(
  (t) => t.id
)
