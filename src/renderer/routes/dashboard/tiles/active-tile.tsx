// src/renderer/routes/dashboard/tiles/active-tile.tsx
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { useTaskList } from '@renderer/hooks/use-task-list'
import { cn } from '@renderer/lib/utils'
import { TaskStatus } from '@shared/types/task'
import { ArrowDown, ArrowUp, Clock3, type LucideIcon } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { StatusDot } from '../components/status-dot'
import { TileShell } from '../components/tile-shell'
import { TileTitle } from '../components/tile-title'
import type { DashboardTileViewport } from '../layout/dashboard-registry'

export interface ActiveTileProps {
  activeCount: number
  engineOnline?: boolean
  viewport: DashboardTileViewport
  className?: string
}

export function ActiveTile({
  activeCount,
  engineOnline = true,
  viewport,
  className,
}: ActiveTileProps) {
  const { t } = useTranslation()
  const { tasks } = useTaskList()

  const counts = useMemo(() => {
    const c = { downloading: 0, seeding: 0, waiting: 0, error: 0 }
    for (const task of tasks) {
      switch (task.status) {
        case TaskStatus.Downloading:
          c.downloading += 1
          break
        case TaskStatus.Seeding:
          c.seeding += 1
          break
        case TaskStatus.Queued:
        case TaskStatus.FetchingMetadata:
          c.waiting += 1
          break
        case TaskStatus.Error:
          c.error += 1
          break
        default:
          break
      }
    }
    return c
  }, [tasks])

  const dotColor =
    engineOnline && counts.downloading > 0
      ? 'bg-emerald-500'
      : 'bg-muted-foreground/40'
  const compact = viewport.contentLevel === 'compact'
  const detailed =
    viewport.contentLevel === 'detailed' || viewport.contentLevel === 'focus'
  const focus = viewport.contentLevel === 'focus'
  const subItems = [
    ['downloading', counts.downloading],
    ['waiting', counts.waiting],
    ['seeding', counts.seeding],
    ['error', counts.error, true],
  ] as const
  const visibleSubItems = subItems.filter(
    ([, , detailedOnly]) => detailed || !detailedOnly
  )

  return (
    <TileShell
      label={t('panel.dashboard.active.title')}
      action={
        <StatusDot
          pulse={engineOnline && counts.downloading > 0}
          className={cn(dotColor)}
        />
      }
      className={className}
    >
      <div
        data-testid="active-content"
        className="flex min-h-0 flex-1 flex-col justify-between gap-3"
      >
        <TileTitle value={activeCount} />
        {compact ? (
          <dl
            data-testid="active-compact-breakdown"
            className="mt-auto flex min-w-0 items-center justify-between gap-2 text-muted-foreground"
          >
            <CompactStatus
              icon={ArrowDown}
              label={t('panel.dashboard.active.downloading')}
              count={counts.downloading}
            />
            <CompactStatus
              icon={Clock3}
              label={t('panel.dashboard.active.waiting')}
              count={counts.waiting}
            />
            <CompactStatus
              icon={ArrowUp}
              label={t('panel.dashboard.active.seeding')}
              count={counts.seeding}
            />
          </dl>
        ) : (
          <div
            data-testid="active-breakdown"
            className={cn(
              'mt-auto grid min-w-0 text-muted-foreground',
              focus
                ? 'grid-cols-4'
                : detailed
                  ? 'grid-cols-2 gap-y-4'
                  : 'grid-cols-3'
            )}
          >
            {visibleSubItems.map(([key, count]) => (
              <div
                key={key}
                className="min-w-0 border-border/70 border-l px-3 first:border-l-0 first:pl-0 last:pr-0"
              >
                <span className="mb-1 block text-[20px] leading-none text-foreground font-semibold">
                  {count}
                </span>
                <span className="block truncate text-[10px] uppercase leading-none">
                  {t(`panel.dashboard.active.${key}`)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </TileShell>
  )
}

function CompactStatus({
  icon: Icon,
  label,
  count,
}: {
  icon: LucideIcon
  label: string
  count: number
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<div className="flex min-w-0 items-center gap-1" />}
      >
        <dt className="shrink-0">
          <Icon className="size-3" aria-hidden />
          <span className="sr-only">{label}</span>
        </dt>
        <dd
          className={cn(
            'min-w-0 truncate text-xs leading-4 tabular-nums',
            count > 0 && 'font-medium text-foreground/80'
          )}
        >
          {count}
        </dd>
      </TooltipTrigger>
      <TooltipContent>
        {label}: {count}
      </TooltipContent>
    </Tooltip>
  )
}
