import { Button } from '@renderer/components/ui/button'
import { Progress } from '@renderer/components/ui/progress'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useByteFormat } from '@renderer/hooks/use-byte-format'
import { useMinuteClock } from '@renderer/hooks/use-minute-clock'
import { useTaskList } from '@renderer/hooks/use-task-list'
import { resolveFailureReason } from '@renderer/lib/failure-reason'
import { openAddTaskDialog } from '@renderer/lib/open-add-task-dialog'
import { formatRelativeTime } from '@renderer/lib/relative-time'
import { projectTaskWindow, type TaskView } from '@renderer/lib/task-views'
import { cn } from '@renderer/lib/utils'
import { useTaskActions } from '@renderer/routes/downloads/inspector/use-task-actions'
import { StatusPill } from '@renderer/routes/downloads/status-pill'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import {
  canAttemptRetry,
  canPause,
  canResume,
} from '@shared/types/task-actions'
import {
  getDownloadProgress,
  getMediaPhaseLabel,
  getOutputSize,
  getStageProgress,
  getTransferMetrics,
  isMediaTask,
  mediaProgressPercent,
} from '@shared/utils/media-progress'
import { useCallback, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router'
import { TileSegmentedControl } from '../components/tile-segmented-control'
import { TileShell } from '../components/tile-shell'
import type { DashboardTileViewport } from '../layout/dashboard-registry'

type TasksTileFixtureModule = typeof import('./tasks-tile.fixture')

const tasksTileFixtureModule: TasksTileFixtureModule | null = import.meta.env
  .DEV
  ? await import('./tasks-tile.fixture')
  : null

const ROW_LIMITS: Readonly<Record<string, number>> = {
  '2x1': 3,
  '2x2': 4,
  '2x3': 7,
  '3x2': 4,
  '3x3': 7,
  '4x2': 4,
}

const STATUS_KEY: Readonly<Record<TaskStatus, string>> = {
  [TaskStatus.Queued]: 'queued',
  [TaskStatus.FetchingMetadata]: 'fetchingMetadata',
  [TaskStatus.MetadataReady]: 'metadataReady',
  [TaskStatus.Downloading]: 'downloading',
  [TaskStatus.Finalizing]: 'finalizing',
  [TaskStatus.Seeding]: 'seeding',
  [TaskStatus.Paused]: 'paused',
  [TaskStatus.Completed]: 'completed',
  [TaskStatus.Error]: 'error',
  [TaskStatus.Removed]: 'error',
}

export interface TasksTileProps {
  engineOnline: boolean
  viewport: DashboardTileViewport
  className?: string
}

interface RowPresentation {
  primary: string
  secondary: string
  progress: number | null
  indeterminate?: boolean
}

function spanKey(viewport: DashboardTileViewport): string {
  return `${viewport.span.w}x${viewport.span.h}`
}

function rowLimit(viewport: DashboardTileViewport): number {
  return ROW_LIMITS[spanKey(viewport)] ?? 4
}

function rowHeightClass(viewport: DashboardTileViewport): string {
  return viewport.contentLevel === 'summary' ? 'h-6' : 'h-11'
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0
  return Math.min(100, Math.max(0, progress * 100))
}

function validTimestamp(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function terminalDisplayTime(task: DownloadTask): number | null {
  if (validTimestamp(task.finishedAt)) return task.finishedAt
  return validTimestamp(task.updatedAt) ? task.updatedAt : null
}

function taskStatusLabel(
  status: TaskStatus,
  translate: (key: string) => string
): string {
  return translate(`panel.downloads.status.${STATUS_KEY[status]}`)
}

function TaskQuickAction({
  task,
  enabled,
}: {
  task: DownloadTask
  enabled: boolean
}) {
  const { t } = useTranslation()
  const selected = useMemo(() => [task], [task])
  const actions = useTaskActions(selected)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const action = actions.pauseCount
    ? { label: t('panel.downloads.action.pause'), run: actions.onPause }
    : actions.resumeCount
      ? { label: t('panel.downloads.action.resume'), run: actions.onResume }
      : actions.retryCount
        ? { label: t('panel.downloads.action.retry'), run: actions.onRetry }
        : null

  if (!action) return null

  async function run() {
    if (!enabled || pendingRef.current || !action) return
    pendingRef.current = true
    setPending(true)
    try {
      await action.run()
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      disabled={!enabled || pending}
      aria-label={`${action.label}: ${task.name}`}
      aria-busy={pending || undefined}
      onClick={() => void run()}
      className="relative z-20 col-start-2 row-start-1 me-1 h-7 min-w-11 px-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground motion-reduce:transition-none"
    >
      {action.label}
    </Button>
  )
}

function TaskRow({
  task,
  view,
  summary,
  engineOnline,
  actionsEnabled,
  now,
  heightClass,
  onOpen,
  onFocusedRowRemoved,
}: {
  task: DownloadTask
  view: TaskView
  summary: boolean
  engineOnline: boolean
  actionsEnabled: boolean
  now: number
  heightClass: string
  onOpen(task: DownloadTask): void
  onFocusedRowRemoved(): void
}) {
  const { formatBytes, formatSpeed } = useByteFormat()
  const { t, i18n } = useTranslation()
  const descriptionId = useId()
  const groupRef = useRef<HTMLDivElement | null>(null)
  const phase = getMediaPhaseLabel(task)
  const statusLabel = phase ? t(phase) : taskStatusLabel(task.status, t)
  let technicalDetail: string | null = null
  let presentation: RowPresentation

  if (view === 'failed') {
    const failure = resolveFailureReason(
      {
        errorCode: task.errorCode,
        errorMessage: task.errorMessage,
        errorDetailKey: task.errorDetailKey,
        errorDetailParams: task.errorDetailParams,
      },
      { t, exists: (key) => i18n.exists(key) }
    )
    technicalDetail = failure.technicalDetail
    presentation = {
      primary: formatRelativeTime(
        terminalDisplayTime(task),
        now,
        i18n.language
      ),
      secondary: failure.reason,
      progress: null,
    }
  } else if (view === 'recent') {
    const finalSize = isMediaTask(task)
      ? getOutputSize(task)
      : task.sizeWhenDone > 0
        ? task.sizeWhenDone
        : task.totalBytes
    presentation = {
      primary: finalSize === null ? '—' : formatBytes(finalSize),
      secondary: formatRelativeTime(
        terminalDisplayTime(task),
        now,
        i18n.language
      ),
      progress: null,
    }
  } else if (
    isMediaTask(task) &&
    (task.status === TaskStatus.Downloading ||
      task.status === TaskStatus.Finalizing ||
      task.status === TaskStatus.Queued)
  ) {
    const progress = getStageProgress(task)
    const transfer = getTransferMetrics(task)
    const downloading = task.mediaProgress?.phase === 'downloading'
    presentation = {
      primary:
        downloading && engineOnline ? formatSpeed(transfer.speedBps) : '',
      secondary:
        progress === null
          ? statusLabel
          : `${statusLabel} ${mediaProgressPercent(progress)}%`,
      progress: progress === null ? null : mediaProgressPercent(progress),
      indeterminate: progress === null,
    }
  } else {
    switch (task.status) {
      case TaskStatus.Downloading:
        presentation = {
          primary: engineOnline ? formatSpeed(task.downloadSpeed) : '',
          secondary: `${statusLabel} ${Math.round(clampProgress(task.progress))}%`,
          progress: clampProgress(task.progress),
        }
        break
      case TaskStatus.Paused: {
        const progress = getDownloadProgress(task)
        const percent =
          progress === null
            ? null
            : isMediaTask(task)
              ? mediaProgressPercent(progress)
              : clampProgress(task.progress)
        presentation = {
          primary: '',
          secondary:
            percent === null
              ? statusLabel
              : `${statusLabel} ${Math.round(percent)}%`,
          progress: percent,
        }
        break
      }
      case TaskStatus.Seeding:
        presentation = {
          primary: engineOnline ? formatSpeed(task.uploadSpeed) : '',
          secondary: statusLabel,
          progress: null,
        }
        break
      default:
        presentation = { primary: '', secondary: statusLabel, progress: null }
    }
  }

  if (view === 'active' && !engineOnline) {
    presentation.primary = ''
    presentation.secondary = t('panel.dashboard.tasks.secondary.offline')
    presentation.indeterminate = false
  }

  const setGroupRef = useCallback(
    (element: HTMLDivElement | null) => {
      if (
        element === null &&
        groupRef.current?.contains(document.activeElement)
      ) {
        onFocusedRowRemoved()
      }
      groupRef.current = element
    },
    [onFocusedRowRemoved]
  )
  const accessibleName = `${task.name}, ${statusLabel}`
  const accessibleDescription = [
    presentation.secondary,
    presentation.primary,
    technicalDetail
      ? t('panel.dashboard.tasks.secondary.technicalDetail', {
          detail: technicalDetail,
        })
      : null,
  ]
    .filter(Boolean)
    .join('. ')
  const title = technicalDetail ? `${task.name}\n${technicalDetail}` : task.name
  const hasQuickAction =
    !summary &&
    view !== 'recent' &&
    (canPause(task) || canResume(task) || canAttemptRetry(task))
  const hasProgress =
    presentation.progress !== null || presentation.indeterminate
  const progressPercent =
    presentation.progress === null
      ? null
      : isMediaTask(task)
        ? presentation.progress
        : Math.round(presentation.progress)
  const showStatusBadge = view === 'active' && engineOnline

  return (
    <li
      className={cn(
        'min-w-0 shrink-0',
        !summary && 'border-b border-border/40 last:border-b-0',
        heightClass
      )}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: A named group keeps navigation, the task action, and progress as accessible siblings. */}
      <div
        ref={setGroupRef}
        role="group"
        aria-label={task.name}
        className={cn(
          'relative grid h-full min-w-0 items-center',
          hasQuickAction
            ? 'grid-cols-[minmax(0,1fr)_auto] gap-x-2'
            : 'grid-cols-1'
        )}
      >
        <button
          type="button"
          data-testid="tasks-row"
          data-task-id={task.id}
          title={title}
          aria-label={accessibleName}
          aria-describedby={descriptionId}
          onClick={() => onOpen(task)}
          className="absolute inset-0 z-0 rounded-md outline-none transition-colors hover:bg-accent/45 focus-visible:bg-accent/45 focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none"
        />
        {summary ? (
          <div
            aria-hidden
            className="pointer-events-none relative z-10 flex h-full min-w-0 items-center gap-2 px-1 text-xs leading-none"
          >
            <span className="min-w-0 truncate font-medium">{task.name}</span>
            {showStatusBadge ? (
              <StatusPill
                status={task.status}
                task={task}
                compact
                className="h-4 max-w-[55%] shrink-0 px-1 py-0 text-[10px] leading-4"
              />
            ) : (
              <span className="max-w-[45%] shrink-0 truncate text-[11px] text-muted-foreground tabular-nums">
                {presentation.primary || presentation.secondary}
              </span>
            )}
          </div>
        ) : (
          <div
            aria-hidden
            className={cn(
              'pointer-events-none relative z-10 col-start-1 row-start-1 flex h-full min-w-0 flex-col justify-center gap-0.5 px-1',
              hasProgress && 'pb-1.5'
            )}
          >
            <span className="min-w-0 truncate text-[13px] font-medium leading-4">
              {task.name}
            </span>
            <span className="flex min-w-0 items-center gap-2 text-[11px] leading-3.5 text-muted-foreground tabular-nums">
              {showStatusBadge ? (
                <span className="flex min-w-0 items-center gap-1.5">
                  <StatusPill
                    status={task.status}
                    task={task}
                    compact
                    className="h-4 min-w-0 px-1 py-0 text-[10px] leading-4"
                  />
                  {progressPercent !== null ? (
                    <span className="shrink-0">{progressPercent}%</span>
                  ) : null}
                </span>
              ) : (
                <span
                  className={cn(
                    'min-w-0 truncate',
                    view === 'failed' && 'text-destructive'
                  )}
                >
                  {presentation.secondary}
                </span>
              )}
              {presentation.primary ? (
                <span className="shrink-0">{presentation.primary}</span>
              ) : null}
            </span>
          </div>
        )}
        <span id={descriptionId} className="sr-only">
          {accessibleDescription}
        </span>
        {!summary && hasProgress ? (
          <Progress
            value={presentation.progress ?? undefined}
            aria-label={
              t('panel.dashboard.tasks.progressLabel', { name: task.name }) +
              (phase ? `: ${statusLabel}` : '')
            }
            className="pointer-events-none relative z-10 col-start-1 row-start-1 mx-1 mb-1 h-0.5 w-auto self-end rounded-full"
            indicatorClassName={
              task.status === TaskStatus.Paused || !engineOnline
                ? 'bg-muted-foreground/50'
                : undefined
            }
          />
        ) : null}
        {hasQuickAction ? (
          <TaskQuickAction task={task} enabled={actionsEnabled} />
        ) : null}
      </div>
    </li>
  )
}

function EmptyState({
  children,
  action,
}: {
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-2 text-center text-[12px] font-medium text-muted-foreground">
      <span role="status" aria-live="polite" aria-atomic="true">
        {children}
      </span>
      {action}
    </div>
  )
}

function LoadingRows({
  viewport,
  count,
}: {
  viewport: DashboardTileViewport
  count: number
}) {
  const { t } = useTranslation()
  const summary = viewport.contentLevel === 'summary'
  const heightClass = rowHeightClass(viewport)

  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {t('panel.dashboard.tasks.loading')}
      </span>
      <ul
        aria-busy="true"
        aria-label={t('panel.dashboard.tasks.loading')}
        className="flex min-h-0 flex-1 flex-col"
      >
        {Array.from({ length: count }, (_, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton slots are positional
            key={index}
            className={cn('flex shrink-0 items-center px-1', heightClass)}
          >
            {summary ? (
              <div className="w-full px-1">
                <Skeleton className="h-3 w-full" />
              </div>
            ) : (
              <div className="grid w-full grid-cols-[1fr_auto] items-center gap-x-4 px-1">
                <div className="grid gap-1">
                  <Skeleton className="h-2.5 w-3/4" />
                  <Skeleton className="h-2 w-1/2" />
                </div>
                <Skeleton className="h-2.5 w-12" />
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  )
}

export function TasksTile({
  engineOnline,
  viewport,
  className,
}: TasksTileProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const taskList = useTaskList()
  const now = useMinuteClock()
  const [view, setView] = useState<TaskView>('active')
  const segmentedControlRef = useRef<HTMLDivElement>(null)

  const fixture = tasksTileFixtureModule
    ? tasksTileFixtureModule.resolveTasksTileFixture(
        searchParams.get(tasksTileFixtureModule.TASKS_TILE_FIXTURE_QUERY),
        true
      )
    : null
  const source = fixture?.source ?? taskList
  const online = fixture?.engineOnline ?? engineOnline
  const displayNow = fixture?.clockNow ?? now
  const limit = rowLimit(viewport)
  const summary = viewport.contentLevel === 'summary'
  const heightClass = rowHeightClass(viewport)
  const projection = useMemo(
    () => projectTaskWindow(source.tasks, view, limit),
    [source.tasks, view, limit]
  )
  const hasOverflow = projection.total > limit
  const visibleRows =
    hasOverflow && summary
      ? projection.rows.slice(0, limit - 1)
      : projection.rows
  const overflowCount = projection.total - visibleRows.length
  const viewOptions = [
    {
      value: 'active' as const,
      label: t('panel.dashboard.tasks.view.active'),
    },
    {
      value: 'failed' as const,
      label: t('panel.dashboard.tasks.view.failed'),
    },
    {
      value: 'recent' as const,
      label: t('panel.dashboard.tasks.view.recent'),
    },
  ]

  const focusSelectedSegment = useCallback(() => {
    segmentedControlRef.current
      ?.querySelector<HTMLElement>(
        '[role="radio"][aria-checked="true"]:not([disabled])'
      )
      ?.focus()
  }, [])

  const routeForView =
    view === 'active'
      ? '/downloads/active'
      : view === 'failed'
        ? '/downloads/error'
        : '/downloads/completed'

  const openTask = useCallback(
    (task: DownloadTask) => {
      navigate(`${routeForView}?task=${encodeURIComponent(task.id)}`)
    },
    [navigate, routeForView]
  )

  let content: React.ReactNode
  if (source.status === 'loading' && !source.hasReadySnapshot) {
    content = <LoadingRows viewport={viewport} count={limit} />
  } else if (source.status === 'error' && !source.hasReadySnapshot) {
    content = (
      <EmptyState
        action={
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => void source.retry()}
          >
            {t('panel.dashboard.tasks.retry')}
          </Button>
        }
      >
        {t('panel.dashboard.tasks.unavailable')}
      </EmptyState>
    )
  } else if (projection.total === 0) {
    if (view === 'active') {
      content = (
        <EmptyState
          action={
            online ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void openAddTaskDialog()}
              >
                {t('panel.dashboard.tasks.newTask')}
              </Button>
            ) : undefined
          }
        >
          {online
            ? t('panel.dashboard.tasks.empty.active')
            : t('panel.dashboard.tasks.offline')}
        </EmptyState>
      )
    } else {
      content = (
        <EmptyState>{t(`panel.dashboard.tasks.empty.${view}`)}</EmptyState>
      )
    }
  } else {
    content = (
      <ul
        aria-label={t(`panel.dashboard.tasks.view.${view}`)}
        data-testid="tasks-list"
        data-view={view}
        data-presentation={spanKey(viewport)}
        className="flex min-h-0 flex-1 flex-col"
      >
        {visibleRows.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            view={view}
            summary={summary}
            engineOnline={online}
            actionsEnabled={online && source.status === 'ready' && !fixture}
            now={displayNow}
            heightClass={heightClass}
            onOpen={openTask}
            onFocusedRowRemoved={focusSelectedSegment}
          />
        ))}
        {hasOverflow ? (
          <li className="mt-auto min-w-0 shrink-0 pt-1">
            <button
              type="button"
              data-testid="tasks-more"
              onClick={() => navigate(routeForView)}
              className="flex h-6 w-full items-center rounded-md px-1 text-left text-[11px] leading-none font-medium text-muted-foreground outline-none transition-colors hover:bg-accent/45 hover:text-foreground focus-visible:bg-accent/45 focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none"
            >
              {t('panel.dashboard.tasks.more', { count: overflowCount })}
            </button>
          </li>
        ) : null}
      </ul>
    )
  }

  return (
    <TileShell
      label={t('panel.dashboard.tasks.title')}
      action={
        <TileSegmentedControl
          ref={segmentedControlRef}
          ariaLabel={t('panel.dashboard.tasks.viewLabel')}
          value={view}
          options={viewOptions}
          onValueChange={setView}
        />
      }
      className={className}
      bodyClassName={cn('min-h-0', !summary && 'pt-2')}
    >
      {content}
    </TileShell>
  )
}
