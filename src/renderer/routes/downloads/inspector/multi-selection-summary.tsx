import { formatBytes, formatDurationHMS } from '@renderer/lib/format'
import type { DownloadTask, TaskStatus } from '@shared/types/task'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

function Card({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3">
      <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <div className="flex flex-col gap-1 text-[12px] text-foreground">
        {children}
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}

export function MultiSelectionSummary({
  tasks,
}: {
  tasks: readonly DownloadTask[]
}) {
  const { t } = useTranslation()
  const agg = useMemo(() => {
    const totalSize = tasks.reduce((s, x) => s + x.sizeWhenDone, 0)
    const downloaded = tasks.reduce((s, x) => s + x.downloadedBytes, 0)
    const avgProgress =
      tasks.reduce((s, x) => s + x.progress, 0) / Math.max(1, tasks.length)
    const combinedDown = tasks.reduce((s, x) => s + x.downloadSpeed, 0)
    const combinedUp = tasks.reduce((s, x) => s + x.uploadSpeed, 0)
    const longestEta = tasks.reduce((m, x) => Math.max(m, x.etaSeconds), 0)
    const counts: Record<string, number> = {}
    for (const x of tasks) counts[x.status] = (counts[x.status] ?? 0) + 1
    return {
      totalSize,
      downloaded,
      avgProgress,
      combinedDown,
      combinedUp,
      longestEta,
      counts,
    }
  }, [tasks])

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Card title={t('panel.downloads.inspector.multi.totals')}>
        <Row
          label={t('panel.downloads.inspector.multi.totalSize')}
          value={formatBytes(agg.totalSize)}
        />
        <Row
          label={t('panel.downloads.inspector.multi.downloaded')}
          value={formatBytes(agg.downloaded)}
        />
        <Row
          label={t('panel.downloads.inspector.multi.avgProgress')}
          value={`${Math.round(agg.avgProgress * 100)}%`}
        />
      </Card>
      <Card title={t('panel.downloads.inspector.multi.liveSpeed')}>
        <Row
          label={t('panel.downloads.inspector.multi.combinedDown')}
          value={`${formatBytes(agg.combinedDown)}/s`}
        />
        <Row
          label={t('panel.downloads.inspector.multi.combinedUp')}
          value={`${formatBytes(agg.combinedUp)}/s`}
        />
        <Row
          label={t('panel.downloads.inspector.multi.longestEta')}
          value={formatDurationHMS(agg.longestEta)}
        />
      </Card>
      <Card title={t('panel.downloads.inspector.multi.statusDist')}>
        {(Object.entries(agg.counts) as [TaskStatus, number][])
          .sort((a, b) => b[1] - a[1])
          .map(([status, n]) => (
            <Row key={status} label={status} value={n.toString()} />
          ))}
      </Card>
    </div>
  )
}
