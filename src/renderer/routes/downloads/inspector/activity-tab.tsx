import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import {
  type TaskInspectorActivitySnapshotCache,
  useTaskInspectorActivity,
} from '@renderer/hooks/use-task-inspector-activity'
import { useTaskSpeedHistory } from '@renderer/hooks/use-task-speed-history'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { RefreshCw } from 'lucide-react'
import {
  type RefObject,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  type ActivityChartRange,
  buildActivityChartModel,
} from './activity-chart-model'
import { buildActivityTimelineModel } from './activity-timeline-model'
import { CurrentSummaryCard } from './current-summary-card'
import { LifetimeTransferCard } from './lifetime-transfer-card'

const LIVE_STATUSES = new Set<TaskStatus>([
  TaskStatus.FetchingMetadata,
  TaskStatus.Downloading,
  TaskStatus.Finalizing,
  TaskStatus.Seeding,
])

function useAvailableWidth(rootRef: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(672)

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return

    const update = (nextWidth: number) => {
      if (!Number.isFinite(nextWidth) || nextWidth <= 0) return
      setWidth(Math.floor(nextWidth))
    }

    update(root.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width)
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [rootRef])

  return width
}

function formatUpdateTime(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp)
}

function ActivitySkeleton() {
  const { t } = useTranslation()
  return (
    <>
      <span className="sr-only" role="status">
        {t('panel.downloads.inspector.activity.loading')}
      </span>
      <div data-testid="task-inspector-activity-layout" className="min-w-0">
        <section
          data-testid="task-inspector-activity-skeleton"
          className="min-h-64 rounded-md border border-border p-3"
        >
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-28 motion-reduce:animate-none" />
            <Skeleton className="h-5 w-36 motion-reduce:animate-none" />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 border-y border-border/60 py-3 @[560px]/activity:grid-cols-5">
            <Skeleton className="h-8 w-24 motion-reduce:animate-none" />
            <Skeleton className="h-8 w-24 motion-reduce:animate-none" />
            <Skeleton className="h-8 w-full motion-reduce:animate-none" />
            <Skeleton className="h-8 w-full motion-reduce:animate-none" />
            <Skeleton className="h-8 w-full motion-reduce:animate-none" />
          </div>
          <Skeleton className="mt-5 h-48 w-full motion-reduce:animate-none" />
        </section>
      </div>
    </>
  )
}

function StateNotice({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2"
    >
      <p className="text-xs text-muted-foreground">{message}</p>
      <Button
        type="button"
        size="xs"
        variant="outline"
        className="motion-reduce:transition-none"
        onClick={onRetry}
      >
        <RefreshCw aria-hidden="true" />
        {t('panel.downloads.inspector.activity.retry')}
      </Button>
    </div>
  )
}

function ActivityTabContent({
  task,
  snapshotCache,
}: {
  task: DownloadTask
  snapshotCache?: TaskInspectorActivitySnapshotCache
}) {
  const { t, i18n } = useTranslation()
  const rootRef = useRef<HTMLDivElement>(null)
  const availableWidth = useAvailableWidth(rootRef)
  const session = useTaskSpeedHistory(task.id)
  const activity = useTaskInspectorActivity(task.id, snapshotCache)
  const [range, setRange] = useState<ActivityChartRange>('lifetime')
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null)

  const snapshot = activity.snapshot
  const effectiveRange = activity.status === 'unavailable' ? 'session' : range
  const timelineModel = useMemo(
    () =>
      buildActivityTimelineModel({
        events: snapshot?.timeline.events ?? [],
        task,
        availableWidth,
        historyDroppedCount: snapshot?.timeline.historyDroppedCount ?? 0,
        historyTruncatedAt: snapshot?.timeline.historyTruncatedAt ?? null,
      }),
    [availableWidth, snapshot, task]
  )
  const chartModel = useMemo(
    () =>
      buildActivityChartModel({
        range: effectiveRange,
        sessionPoints: session.history,
        lifetimePoints: snapshot?.lifetime.points ?? [],
        markerGroups: timelineModel.markerGroups,
        selectedMarkerId,
      }),
    [
      effectiveRange,
      selectedMarkerId,
      session.history,
      snapshot,
      timelineModel.markerGroups,
    ]
  )

  let emptyMessage: string | null = null
  if (chartModel.emptyState === 'empty') {
    emptyMessage =
      effectiveRange === 'lifetime'
        ? t('panel.downloads.inspector.activity.lifetimeEmpty')
        : LIVE_STATUSES.has(task.status)
          ? t('panel.downloads.inspector.activity.collecting')
          : t('panel.downloads.inspector.activity.noSessionHistory')
  }

  const initialLoading = activity.status === 'loading' || session.isLoading
  const coverageGap = snapshot?.summary.coverageGapAt != null
  const truncatedCount = snapshot?.summary.historyDroppedCount ?? 0

  return (
    <div
      ref={rootRef}
      data-testid="task-inspector-activity-root"
      className="@container/activity min-h-0 min-w-0 space-y-3"
    >
      {initialLoading ? (
        <ActivitySkeleton />
      ) : (
        <>
          {activity.status === 'unavailable' && (
            <StateNotice
              message={t('panel.downloads.inspector.activity.unavailable')}
              onRetry={activity.retry}
            />
          )}
          {activity.status === 'stale' && (
            <StateNotice
              message={t('panel.downloads.inspector.activity.stale.message', {
                time: formatUpdateTime(
                  activity.snapshot.lifetime.updatedAt,
                  i18n.language
                ),
              })}
              onRetry={activity.retry}
            />
          )}

          <div data-testid="task-inspector-activity-layout" className="min-w-0">
            <LifetimeTransferCard
              model={chartModel}
              range={effectiveRange}
              sampleCount={chartModel.points.length}
              lifetimeSummary={snapshot?.lifetime ?? null}
              stale={activity.status === 'stale'}
              coverageGap={coverageGap}
              truncatedCount={truncatedCount}
              lifetimeAvailable={activity.status !== 'unavailable'}
              emptyMessage={emptyMessage}
              summary={
                <CurrentSummaryCard
                  task={task}
                  lifetime={snapshot?.lifetime ?? null}
                />
              }
              onRangeChange={(nextRange) => {
                if (
                  nextRange === 'lifetime' &&
                  activity.status === 'unavailable'
                ) {
                  return
                }
                setRange(nextRange)
              }}
              onSelectMarker={setSelectedMarkerId}
            />
          </div>
        </>
      )}
    </div>
  )
}

export function ActivityTab({
  task,
  snapshotCache,
}: {
  task: DownloadTask
  snapshotCache?: TaskInspectorActivitySnapshotCache
}) {
  return (
    <ActivityTabContent
      key={task.id}
      task={task}
      snapshotCache={snapshotCache}
    />
  )
}
