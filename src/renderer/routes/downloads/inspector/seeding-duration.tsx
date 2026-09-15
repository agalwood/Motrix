import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import {
  type TaskInspectorActivitySnapshotCache,
  useTaskInspectorActivity,
} from '@renderer/hooks/use-task-inspector-activity'
import { formatDurationHMS } from '@renderer/lib/format'
import { useTranslation } from 'react-i18next'
import { formatTaskTimestamp } from '../format-task-timestamp'

export function SeedingDuration({
  taskId,
  snapshotCache,
}: {
  taskId: string
  snapshotCache?: TaskInspectorActivitySnapshotCache
}) {
  const { t, i18n } = useTranslation()
  const activity = useTaskInspectorActivity(taskId, snapshotCache)
  const seeding = activity.snapshot?.summary.seeding
  const value = seeding
    ? seeding.activeMs === 0
      ? '00:00'
      : formatDurationHMS(seeding.activeMs / 1000)
    : '—'
  const since = seeding
    ? formatTaskTimestamp(seeding.trackingStartedAt, i18n.language, Date.now())
        ?.full
    : null
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="tabular-nums" data-slot="task-seeding-duration" />
        }
      >
        {value}
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-64">
        {since
          ? t('panel.downloads.inspector.overview.seedingRecordedSince', {
              date: since,
            })
          : t('panel.downloads.inspector.overview.seedingUnavailable')}
        {(activity.status === 'stale' ||
          activity.snapshot?.summary.coverageGapAt != null) && (
          <p>{t('panel.downloads.inspector.activity.coverageGap')}</p>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
