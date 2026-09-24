import { useByteFormat } from '@renderer/hooks/use-byte-format'
import { formatDurationHMS, formatProgressPercent } from '@renderer/lib/format'
import { type DownloadTask, TaskStatus } from '@shared/types/task'
import {
  getDownloadProgress,
  getOutputSize,
  isMediaProcessing,
  isMediaTask,
  mediaProgressPercent,
} from '@shared/utils/media-progress'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { getTaskEta, getTaskSpeed } from '../task-column-values'

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
  const { formatBytes, formatSpeed } = useByteFormat()

  const { t } = useTranslation()
  const agg = useMemo(() => {
    const sizes = tasks.map(getOutputSize)
    const totalSize = sizes.includes(null)
      ? null
      : sizes.reduce<number>((s, x) => s + (x ?? 0), 0)
    const hasMedia = tasks.some(isMediaTask)
    const processing = tasks.filter(isMediaProcessing).length
    const progress = tasks.map(getDownloadProgress)
    const downloaded = tasks.reduce((s, x) => s + x.downloadedBytes, 0)
    const avgProgress = progress.includes(null)
      ? null
      : progress.reduce<number>((s, x) => s + (x ?? 0), 0) /
        Math.max(1, tasks.length)
    const combinedDown = tasks.reduce(
      (s, x) => s + (getTaskSpeed(x, 'downloadSpeed') ?? 0),
      0
    )
    const combinedUp = tasks.reduce(
      (s, x) => s + (getTaskSpeed(x, 'uploadSpeed') ?? 0),
      0
    )
    const etas = tasks
      .filter(
        (task) =>
          task.status !== TaskStatus.Completed &&
          task.status !== TaskStatus.Seeding
      )
      .map(getTaskEta)
    const longestEta =
      hasMedia && etas.includes(null)
        ? null
        : etas.reduce<number>((longest, eta) => Math.max(longest, eta ?? 0), 0)
    const counts: Record<string, number> = {}
    for (const x of tasks) counts[x.status] = (counts[x.status] ?? 0) + 1
    return {
      totalSize,
      hasMedia,
      processing,
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
          value={agg.totalSize === null ? '—' : formatBytes(agg.totalSize)}
        />
        <Row
          label={t('panel.downloads.inspector.multi.downloaded')}
          value={formatBytes(agg.downloaded)}
        />
        <Row
          label={t(
            agg.hasMedia
              ? 'panel.downloads.media.avgDownloadProgress'
              : 'panel.downloads.inspector.multi.avgProgress'
          )}
          value={
            agg.avgProgress === null
              ? '—'
              : `${agg.hasMedia ? mediaProgressPercent(agg.avgProgress) : formatProgressPercent(agg.avgProgress)}%`
          }
        />
      </Card>
      <Card title={t('panel.downloads.inspector.multi.liveSpeed')}>
        <Row
          label={t('panel.downloads.inspector.multi.combinedDown')}
          value={formatSpeed(agg.combinedDown)}
        />
        <Row
          label={t('panel.downloads.inspector.multi.combinedUp')}
          value={formatSpeed(agg.combinedUp)}
        />
        <Row
          label={t('panel.downloads.inspector.multi.longestEta')}
          value={
            agg.longestEta === null ? '—' : formatDurationHMS(agg.longestEta)
          }
        />
      </Card>
      <Card title={t('panel.downloads.inspector.multi.statusDist')}>
        {agg.hasMedia && (
          <Row
            label={t('panel.downloads.media.processingTasks')}
            value={String(agg.processing)}
          />
        )}
        {(Object.entries(agg.counts) as [TaskStatus, number][])
          .sort((a, b) => b[1] - a[1])
          .map(([status, n]) => (
            <Row key={status} label={status} value={n.toString()} />
          ))}
      </Card>
    </div>
  )
}
