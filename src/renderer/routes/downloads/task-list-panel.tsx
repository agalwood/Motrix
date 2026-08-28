import { useSelectableList } from '@renderer/components/desktop-kit/hooks/use-selectable-list'
import { MarqueeOverlay } from '@renderer/components/desktop-kit/marquee-selection/marquee-overlay'
import type { SelectionStore } from '@renderer/components/desktop-kit/selection/types'
import { VirtualList } from '@renderer/components/desktop-kit/virtual-list/virtual-list'
import type { DownloadTask } from '@shared/types/task'
import { useCallback } from 'react'
import { EmptyTasks } from './empty-tasks'
import type { DownloadsTab } from './filter'
import { TaskColumnHeader } from './task-column-header'
import { TaskRow } from './task-row'

const ROW_HEIGHT = 48
const HEADER_HEIGHT = 36

export interface TaskListPanelProps {
  tasks: readonly DownloadTask[]
  hasAnyTasks: boolean
  selection: SelectionStore<DownloadTask>
  filter: DownloadsTab
  search: string
  onClearSearch: () => void
}

export function TaskListPanel({
  tasks,
  hasAnyTasks,
  selection,
  filter,
  search,
  onClearSearch,
}: TaskListPanelProps) {
  const getId = useCallback((t: DownloadTask) => t.id, [])
  const {
    listRef,
    listProps,
    marqueeProps,
    getRowProps,
    headerCheckbox,
    onKeyDown,
  } = useSelectableList({
    items: tasks as DownloadTask[],
    getId,
    rowHeight: ROW_HEIGHT,
    headerHeight: HEADER_HEIGHT,
    store: selection,
  })

  if (tasks.length === 0) {
    return (
      <EmptyTasks
        filter={filter}
        search={search}
        hasAnyTasks={hasAnyTasks}
        onClearSearch={onClearSearch}
      />
    )
  }

  return (
    <div
      role="listbox"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border"
    >
      <VirtualList
        ref={listRef}
        {...listProps}
        className="min-h-full"
        renderHeader={() => (
          <TaskColumnHeader headerCheckbox={headerCheckbox} />
        )}
        renderRow={({ item, index }) => (
          <TaskRow task={item} rowProps={getRowProps(index)} />
        )}
        renderEmpty={() => null}
      />
      <MarqueeOverlay {...marqueeProps} />
    </div>
  )
}
