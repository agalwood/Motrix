import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useTaskActivity } from '@renderer/hooks/use-task-activity'
import { formatDateTime } from '@renderer/lib/format'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ActivityCalendar } from '../activity/activity-calendar'
import { TileShell } from '../components/tile-shell'
import type { DashboardTileViewport } from '../layout/dashboard-registry'

const KEY_ROOT = 'panel.dashboard.activity'
const CALENDAR_FOOTPRINT_CLASS = 'min-h-14'

export interface ActivityTileProps {
  viewport: DashboardTileViewport
  interactive?: boolean
}

export function ActivityTile({
  viewport,
  interactive = true,
}: ActivityTileProps) {
  const { t, i18n } = useTranslation()
  const activity = useTaskActivity()

  const retry = () => {
    void activity.retry()
  }

  let notice: ReactNode
  let content: ReactNode
  if (activity.status === 'loading') {
    content = (
      <div
        role="status"
        aria-label={t(`${KEY_ROOT}.loading`)}
        className={`flex min-h-0 flex-1 items-center ${CALENDAR_FOOTPRINT_CLASS}`}
      >
        <Skeleton className="h-full min-h-14 w-full rounded-md" />
      </div>
    )
  } else if (activity.status === 'unavailable') {
    content = (
      <div
        role="alert"
        className={`flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center ${CALENDAR_FOOTPRINT_CLASS}`}
      >
        <p className="text-xs text-muted-foreground">
          {t(`${KEY_ROOT}.unavailable`)}
        </p>
        <Button type="button" size="sm" variant="outline" onClick={retry}>
          {t(`${KEY_ROOT}.retry`)}
        </Button>
      </div>
    )
  } else {
    const { snapshot } = activity
    const statusMessages = [
      activity.status === 'refreshFailed'
        ? t(`${KEY_ROOT}.refreshFailed`)
        : null,
      snapshot.coverage.coverageGapAt !== null
        ? t(`${KEY_ROOT}.coverageDegraded`, {
            time: formatDateTime(
              snapshot.coverage.coverageGapAt,
              i18n.language
            ),
          })
        : null,
    ].filter((message): message is string => message !== null)
    notice = statusMessages.length > 0 && (
      <div
        role="status"
        aria-live="polite"
        className="flex max-w-[64cqw] items-center gap-1 text-[10px] leading-3 text-muted-foreground"
      >
        <span className="min-w-0 truncate" title={statusMessages.join(' · ')}>
          {statusMessages.join(' · ')}
        </span>
        {activity.status === 'refreshFailed' && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-5 shrink-0 px-1.5 text-[10px]"
            onClick={retry}
          >
            {t(`${KEY_ROOT}.retry`)}
          </Button>
        )}
      </div>
    )
    content = (
      <ActivityCalendar
        snapshot={snapshot}
        contentLevel={viewport.contentLevel}
        interactive={interactive}
        className="min-h-0 flex-1"
      />
    )
  }

  return (
    <TileShell
      label={t(`${KEY_ROOT}.title`)}
      bodyClassName="overflow-hidden"
      className="@container"
      action={notice}
    >
      <span className="sr-only">{t(`${KEY_ROOT}.completedIntensity`)}</span>
      {content}
    </TileShell>
  )
}
