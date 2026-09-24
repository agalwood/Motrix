import { Progress } from '@renderer/components/ui/progress'
import { formatProgressPercent } from '@renderer/lib/format'
import { getProgressBarTone } from '@renderer/lib/task-status-ui'
import { cn } from '@renderer/lib/utils'
import type { DownloadTask } from '@shared/types/task'
import {
  getMediaPhaseLabel,
  getStageProgress,
  isMediaTask,
  mediaProgressPercent,
} from '@shared/utils/media-progress'
import { useTranslation } from 'react-i18next'

export function TaskProgress({ task }: { task: DownloadTask }) {
  const { t } = useTranslation()
  const progress = getStageProgress(task)
  const pct =
    progress === null
      ? null
      : isMediaTask(task)
        ? mediaProgressPercent(progress)
        : formatProgressPercent(progress)
  const phase = getMediaPhaseLabel(task)
  const label = [phase ? t(phase) : null, pct === null ? '—' : `${pct}%`]
    .filter(Boolean)
    .join(' ')
  return (
    <div className="flex items-center gap-2" title={label}>
      <Progress
        value={pct ?? undefined}
        indicatorClassName={cn(
          getProgressBarTone(task.status),
          pct === null && !phase && 'w-0 animate-none'
        )}
        aria-label={`${task.name}: ${label}`}
        className="h-1 min-w-4 flex-1"
      />
      <span className="min-w-0 shrink truncate text-right">{label}</span>
    </div>
  )
}
