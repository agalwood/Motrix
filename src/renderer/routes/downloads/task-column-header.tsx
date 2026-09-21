import { ResizeHandle } from '@renderer/components/desktop-kit/resize-handle'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { cn } from '@renderer/lib/utils'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  defaultTaskColumns,
  TASK_COLUMNS,
  type TaskColumn,
  taskGridStyle,
} from './columns'
import { ColumnVisibilityItems } from './list-view-menu'
import {
  DEFAULT_TASK_SORT,
  nextTaskSort,
  type TaskSort,
  type TaskSortColumn,
} from './sort'
import { useDownloadsView } from './view-preferences'

export interface TaskColumnHeaderProps {
  sort: TaskSort
  onSort: (column: TaskSortColumn) => void
  columns?: TaskColumn[]
}

export function TaskColumnHeader({
  sort,
  onSort,
  columns = defaultTaskColumns(),
}: TaskColumnHeaderProps) {
  const { t } = useTranslation()
  const setWidth = useDownloadsView((state) => state.setColumnWidth)
  const moveColumn = useDownloadsView((state) => state.moveColumn)
  const dragging = useRef<TaskSortColumn | null>(null)
  const effectiveSort = sort ?? DEFAULT_TASK_SORT
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          // biome-ignore lint/a11y/useSemanticElements: Virtualized rows use CSS grids within a scrolling div.
          <div
            role="row"
            tabIndex={-1}
            aria-rowindex={1}
            className="sticky top-0 z-10 grid h-9 shrink-0 items-center border-b border-border bg-background px-3 text-xs font-medium text-muted-foreground"
            style={taskGridStyle(columns)}
          />
        }
      >
        {columns.map((column, index) => {
          const id = column.id
          const active = effectiveSort.column === id
          const speedColumn = id === 'down' || id === 'up'
          const label = t(
            speedColumn
              ? `panel.downloads.columnHeader.${id}`
              : `panel.downloads.column.${id}`
          )
          const accessibleLabel = speedColumn
            ? t(`panel.downloads.sort.${id}`)
            : label
          const next = nextTaskSort(effectiveSort, id)
          const SortIcon =
            effectiveSort.direction === 'asc' ? ChevronUp : ChevronDown
          return (
            // biome-ignore lint/a11y/useSemanticElements: Column headers belong to the virtual ARIA grid.
            <div
              key={id}
              tabIndex={-1}
              role="columnheader"
              aria-colindex={index + 1}
              aria-sort={
                active
                  ? effectiveSort.direction === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : undefined
              }
              className="relative min-w-0"
              onDragOver={(event) => {
                if (dragging.current) event.preventDefault()
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (dragging.current) moveColumn(dragging.current, id)
                dragging.current = null
              }}
            >
              <button
                type="button"
                draggable
                aria-pressed={active}
                aria-label={
                  active
                    ? t(`panel.downloads.sort.${effectiveSort.direction}`, {
                        column: accessibleLabel,
                      })
                    : accessibleLabel
                }
                title={t(
                  `panel.downloads.sort.${next.direction === 'asc' ? 'sortAscending' : 'sortDescending'}`,
                  { column: accessibleLabel }
                )}
                className={cn(
                  'flex h-7 w-full min-w-0 cursor-default items-center gap-1 rounded-sm px-2 text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
                  active && 'font-semibold text-foreground'
                )}
                onClick={() => onSort(id)}
                onDragStart={(event) => {
                  dragging.current = id
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', id)
                }}
                onDragEnd={() => {
                  dragging.current = null
                }}
                onKeyDown={(event) => {
                  event.stopPropagation()
                  if (
                    !event.altKey ||
                    !event.shiftKey ||
                    !['ArrowLeft', 'ArrowRight'].includes(event.key)
                  )
                    return
                  event.preventDefault()
                  const neighbor =
                    columns[index + (event.key === 'ArrowLeft' ? -1 : 1)]
                  if (!neighbor) return
                  if (event.key === 'ArrowLeft') moveColumn(id, neighbor.id)
                  else moveColumn(neighbor.id, id)
                }}
                onMouseDownCapture={(event) => event.stopPropagation()}
              >
                <span className="truncate">{label}</span>
                {active && (
                  <SortIcon
                    aria-hidden="true"
                    className="ml-auto size-3 shrink-0"
                  />
                )}
              </button>
              <ResizeHandle
                label={t('panel.downloads.view.resizeColumn', {
                  column: accessibleLabel,
                })}
                orientation="vertical"
                value={column.width}
                min={TASK_COLUMNS[id].min}
                max={TASK_COLUMNS[id].max}
                className="absolute -right-1 top-1 z-10 h-5 w-2 cursor-col-resize touch-none border-r border-border/50 outline-none focus-visible:bg-ring/30"
                onChange={(width) => setWidth(id, width, false)}
                onCommit={(width) => setWidth(id, width)}
              />
            </div>
          )
        })}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ColumnVisibilityItems />
      </ContextMenuContent>
    </ContextMenu>
  )
}
