import { useByteFormat } from '@renderer/hooks/use-byte-format'
import { resolveFailureReason } from '@renderer/lib/failure-reason'
import { formatDurationHMS, formatProgressPercent } from '@renderer/lib/format'
import { getProgressBarTone } from '@renderer/lib/task-status-ui'
import { cn } from '@renderer/lib/utils'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { memo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  defaultTaskColumns,
  TASK_COLUMNS,
  type TaskColumn,
  taskGridStyle,
} from './columns'
import type { TaskSortColumn } from './sort'
import { StatusPill } from './status-pill'
import {
  getTaskConnections,
  getTaskEta,
  getTaskSpeed,
  getTaskTimestamp,
} from './task-column-values'
import { TaskTimestamp } from './task-timestamp'

export interface TaskRowProps {
  task: DownloadTask
  columns?: TaskColumn[]
  index?: number
  id?: string
  rowProps: {
    selected: boolean
    focused: boolean
    onClick: (e: React.MouseEvent) => void
    onCheckboxChange: () => void
  }
}

function TaskRowBase({
  task,
  rowProps,
  columns = defaultTaskColumns(),
  index = 0,
  id,
}: TaskRowProps) {
  const { formatBytes, formatSpeed } = useByteFormat()
  const { t, i18n } = useTranslation()
  const pct = formatProgressPercent(task.progress)
  const downloadSpeed = getTaskSpeed(task, 'downloadSpeed')
  const uploadSpeed = getTaskSpeed(task, 'uploadSpeed')
  const eta = getTaskEta(task)
  const failure =
    task.status === TaskStatus.Error
      ? resolveFailureReason(
          {
            errorCode: task.errorCode,
            errorMessage: task.errorMessage,
            errorDetailKey: task.errorDetailKey,
            errorDetailParams: task.errorDetailParams,
          },
          { t, exists: (key) => i18n.exists(key) }
        )
      : null
  const extensionIndex = task.name.lastIndexOf('.')
  const extension =
    extensionIndex > 0 && task.name.length - extensionIndex <= 16
      ? task.name.slice(extensionIndex)
      : ''
  const cells: Record<TaskSortColumn, ReactNode> = {
    name: (
      <span
        className="flex min-w-0 font-medium"
        title={
          failure
            ? `${task.name}\n${failure.reason}\n${failure.technicalDetail ?? ''}`
            : task.name
        }
      >
        <span className="truncate">
          {extension ? task.name.slice(0, -extension.length) : task.name}
        </span>
        {extension && <span className="shrink-0">{extension}</span>}
      </span>
    ),
    size: formatBytes(task.sizeWhenDone),
    progress: (
      <span className="flex items-center gap-2">
        <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
          <span
            className={cn('block h-full', getProgressBarTone(task.status))}
            style={{ width: `${pct}%` }}
          />
        </span>
        <span className="w-10 shrink-0 text-right">{pct}%</span>
      </span>
    ),
    status: <StatusPill status={task.status} compact />,
    down: downloadSpeed === null ? '—' : formatSpeed(downloadSpeed),
    up: uploadSpeed === null ? '—' : formatSpeed(uploadSpeed),
    eta: eta === null ? '—' : formatDurationHMS(eta),
    connections: getTaskConnections(task),
    createdAt: (
      <TaskTimestamp timestamp={getTaskTimestamp(task, 'createdAt')} />
    ),
    finishedAt: (
      <TaskTimestamp
        timestamp={getTaskTimestamp(task, 'finishedAt')}
        pending={task.status !== TaskStatus.Completed}
      />
    ),
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: This row is positioned by the virtual ARIA grid.
    <div
      role="row"
      id={id}
      data-task-id={task.id}
      data-focused={rowProps.focused || undefined}
      data-alternate={index % 2 === 1 || undefined}
      aria-label={task.name}
      aria-rowindex={index + 2}
      aria-selected={rowProps.selected}
      aria-description={failure?.reason}
      tabIndex={-1}
      onClick={rowProps.onClick}
      onKeyDown={() => {}}
      title={failure?.technicalDetail ?? undefined}
      className="downloads-task-row grid h-9 cursor-default select-none items-center px-3 text-xs"
      style={taskGridStyle(columns)}
    >
      {columns.map((column, columnIndex) => (
        // biome-ignore lint/a11y/useSemanticElements: Grid cells belong to virtual rows rather than a native table.
        <div
          key={column.id}
          tabIndex={-1}
          role="gridcell"
          aria-colindex={columnIndex + 1}
          className={cn(
            'min-w-0 overflow-hidden px-2 tabular-nums',
            TASK_COLUMNS[column.id].numeric && 'text-right'
          )}
        >
          {cells[column.id]}
        </div>
      ))}
    </div>
  )
}
export const TaskRow = memo(TaskRowBase)
