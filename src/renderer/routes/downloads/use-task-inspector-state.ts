import type { SelectionStore } from '@renderer/components/desktop-kit/selection/types'
import { isTaskAvailable } from '@shared/lib/task-navigation'
import type { DownloadTask } from '@shared/types/task'
import { useMemo } from 'react'
import { useDownloadsView } from './view-preferences'

export function useTaskInspectorState(
  selection: SelectionStore<DownloadTask>,
  tasks: readonly DownloadTask[]
) {
  const ids = selection((state) => state.committedSelectedIds)
  const requested = useDownloadsView((state) => state.inspectorVisible)
  const selected = useMemo(
    () =>
      tasks.filter((task) => ids.has(task.id) && isTaskAvailable(task.status)),
    [ids, tasks]
  )

  // Committed selection keeps marquee previews from toggling the drawer.
  return { selected, open: requested && selected.length > 0 }
}
