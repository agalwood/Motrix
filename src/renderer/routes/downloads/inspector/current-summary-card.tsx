import { formatDurationHMS } from '@renderer/lib/format'
import { formatSpeed } from '@renderer/lib/speed-chart'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import type { TaskInspectorActivitySnapshot } from '@shared/types/task-inspector-activity'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export interface CurrentSummaryCardProps {
  task: DownloadTask
  lifetime: TaskInspectorActivitySnapshot['lifetime'] | null
}

const LIVE_STATUSES = new Set<TaskStatus>([
  TaskStatus.FetchingMetadata,
  TaskStatus.Downloading,
  TaskStatus.Finalizing,
  TaskStatus.Seeding,
])

function activeDuration(activeMs: number): string {
  if (!Number.isFinite(activeMs) || activeMs <= 0) return '00:00'
  return formatDurationHMS(activeMs / 1_000)
}

function LiveMetric({
  direction,
  value,
  label,
}: {
  direction: 'download' | 'upload'
  value: number
  label: string
}) {
  const Icon = direction === 'download' ? ArrowDown : ArrowUp
  const color =
    direction === 'download'
      ? 'text-[hsl(var(--chart-1))]'
      : 'text-[hsl(var(--chart-2))]'
  const background =
    direction === 'download'
      ? 'bg-[hsl(var(--chart-1)/0.12)]'
      : 'bg-[hsl(var(--chart-2)/0.12)]'
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden="true"
        className={`flex size-7 shrink-0 items-center justify-center rounded-full ${background}`}
      >
        <Icon className={`size-3.5 ${color}`} />
      </span>
      <div className="min-w-0">
        <span className="whitespace-nowrap text-base font-semibold tracking-tight text-foreground tabular-nums">
          {formatSpeed(value)}
        </span>
        <p className="mt-0.5 text-[10px] font-medium leading-none text-muted-foreground">
          {label}
        </p>
      </div>
    </div>
  )
}

function SummaryRow({
  label,
  accessibleLabel,
  value,
}: {
  label: string
  accessibleLabel: string
  value: string
}) {
  return (
    <div className="min-w-0 px-3 first:pl-0 last:pr-0">
      <dt className="text-[10px] font-medium leading-none text-muted-foreground">
        <span className="sr-only">{accessibleLabel}</span>
        <span aria-hidden="true">{label}</span>
      </dt>
      <dd className="mt-1 whitespace-nowrap text-sm font-semibold tracking-tight text-foreground tabular-nums">
        {value}
      </dd>
    </div>
  )
}

export function CurrentSummaryCard({
  task,
  lifetime,
}: CurrentSummaryCardProps) {
  const { t } = useTranslation()
  const unavailable = t('panel.downloads.inspector.activity.notAvailable')
  const live = LIVE_STATUSES.has(task.status)

  return (
    <section
      data-testid="task-inspector-activity-summary-card"
      className="@container/summary mt-3 min-w-0 border-y border-border/60 py-3"
      aria-labelledby="task-inspector-activity-summary-title"
    >
      <h4 id="task-inspector-activity-summary-title" className="sr-only">
        {t('panel.downloads.inspector.activity.summary.title')}
      </h4>
      <div className="grid gap-3 @[560px]/summary:grid-cols-[minmax(0,1fr)_minmax(17rem,0.9fr)] @[560px]/summary:items-center @[560px]/summary:gap-5">
        <div className="grid grid-cols-2 gap-3">
          <LiveMetric
            direction="download"
            value={live ? task.downloadSpeed : 0}
            label={t('panel.downloads.inspector.activity.download')}
          />
          <LiveMetric
            direction="upload"
            value={live ? task.uploadSpeed : 0}
            label={t('panel.downloads.inspector.activity.upload')}
          />
        </div>
        <dl
          data-testid="task-inspector-activity-summary-secondary"
          className="grid grid-cols-3 divide-x divide-border/60 border-t border-border/60 pt-3 @[560px]/summary:border-t-0 @[560px]/summary:pt-0"
        >
          <SummaryRow
            label={t('panel.downloads.inspector.activity.summary.average')}
            accessibleLabel={t(
              'panel.downloads.inspector.activity.summary.averageExpanded'
            )}
            value={
              lifetime
                ? formatSpeed(lifetime.averageDownloadSpeed)
                : unavailable
            }
          />
          <SummaryRow
            label={t('panel.downloads.inspector.activity.summary.peak')}
            accessibleLabel={t(
              'panel.downloads.inspector.activity.summary.peakExpanded'
            )}
            value={
              lifetime ? formatSpeed(lifetime.peakDownloadSpeed) : unavailable
            }
          />
          <SummaryRow
            label={t('panel.downloads.inspector.activity.summary.active')}
            accessibleLabel={t(
              'panel.downloads.inspector.activity.summary.activeExpanded'
            )}
            value={lifetime ? activeDuration(lifetime.activeMs) : unavailable}
          />
        </dl>
      </div>
    </section>
  )
}
