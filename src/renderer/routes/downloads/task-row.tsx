import { Checkbox } from '@renderer/components/ui/checkbox'
import { resolveFailureReason } from '@renderer/lib/failure-reason'
import { formatBytes, formatDurationHMS } from '@renderer/lib/format'
import { getProgressBarTone } from '@renderer/lib/task-status-ui'
import { cn } from '@renderer/lib/utils'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus, TaskType } from '@shared/types/task'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { StatusPill } from './status-pill'
import { TASK_GRID_MIN_WIDTH, TASK_GRID_TEMPLATE } from './task-column-header'

export interface TaskRowProps {
  task: DownloadTask
  rowProps: {
    selected: boolean
    focused: boolean
    onClick: (e: React.MouseEvent) => void
    onCheckboxChange: () => void
  }
}

function TaskRowBase({ task, rowProps }: TaskRowProps) {
  const { t, i18n } = useTranslation()
  const pct = Math.round(task.progress * 100)
  const showDash = (value: number) =>
    value <= 0 || task.status === TaskStatus.Completed
  const hideEta =
    task.status === TaskStatus.Paused || task.status === TaskStatus.Completed
  const connections =
    task.type === TaskType.Bt || task.type === TaskType.Magnet
      ? `${task.bt?.peers ?? 0}`
      : task.connections.toString()

  const isError = task.status === TaskStatus.Error
  const failure = isError
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
  return (
    <div
      role="option"
      aria-selected={rowProps.selected}
      tabIndex={-1}
      onClick={rowProps.onClick}
      onKeyDown={() => {}}
      title={failure?.technicalDetail ?? undefined}
      className={cn(
        'grid h-12 cursor-default select-none items-center gap-3 border-b border-border/50 px-3 text-[12.5px]',
        rowProps.selected && 'bg-accent/40',
        !rowProps.selected && rowProps.focused && 'bg-accent/10'
      )}
      style={{
        gridTemplateColumns: TASK_GRID_TEMPLATE,
        minWidth: TASK_GRID_MIN_WIDTH,
      }}
    >
      <Checkbox
        checked={rowProps.selected}
        onCheckedChange={() => rowProps.onCheckboxChange()}
        onClick={(e) => e.stopPropagation()}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-medium text-foreground">
          {task.name}
        </span>
        <span className="truncate text-[11px] text-muted-foreground">
          {failure
            ? failure.reason
            : `${task.type.toUpperCase()} · ${task.fileCount} files`}
        </span>
      </div>
      <span className="tabular-nums">{formatBytes(task.sizeWhenDone)}</span>
      <div className="flex flex-col gap-1">
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full', getProgressBarTone(task.status))}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex justify-between text-[10.5px] text-muted-foreground">
          <span>{pct}%</span>
          <span className="tabular-nums">
            {formatBytes(task.downloadedBytes)}
          </span>
        </div>
      </div>
      <StatusPill status={task.status} />
      <span className="tabular-nums">
        {showDash(task.downloadSpeed)
          ? '—'
          : `${formatBytes(task.downloadSpeed)}/s`}
      </span>
      <span className="tabular-nums">
        {showDash(task.uploadSpeed)
          ? '—'
          : `${formatBytes(task.uploadSpeed)}/s`}
      </span>
      <span className="tabular-nums">
        {hideEta ? '—' : formatDurationHMS(task.etaSeconds)}
      </span>
      <span className="tabular-nums text-muted-foreground">{connections}</span>
    </div>
  )
}

export const TaskRow = memo(TaskRowBase, (prev, next) => {
  const a = prev.task
  const b = next.task
  return (
    prev.rowProps.selected === next.rowProps.selected &&
    prev.rowProps.focused === next.rowProps.focused &&
    a.id === b.id &&
    a.status === b.status &&
    a.progress === b.progress &&
    a.downloadSpeed === b.downloadSpeed &&
    a.uploadSpeed === b.uploadSpeed &&
    a.etaSeconds === b.etaSeconds &&
    a.bt?.peers === b.bt?.peers &&
    a.errorCode === b.errorCode &&
    a.errorMessage === b.errorMessage &&
    a.errorDetailKey === b.errorDetailKey &&
    a.errorDetailParams === b.errorDetailParams &&
    a.diagnosisRevision === b.diagnosisRevision
  )
})
