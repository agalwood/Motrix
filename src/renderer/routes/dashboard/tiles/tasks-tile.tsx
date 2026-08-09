import { Button } from '@renderer/components/ui/button'
import { Progress } from '@renderer/components/ui/progress'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useMinuteClock } from '@renderer/hooks/use-minute-clock'
import { useTaskList } from '@renderer/hooks/use-task-list'
import { resolveFailureReason } from '@renderer/lib/failure-reason'
import { formatBytes } from '@renderer/lib/format'
import { openAddTaskDialog } from '@renderer/lib/open-add-task-dialog'
import { formatRelativeTime } from '@renderer/lib/relative-time'
import { TASK_TYPE_META } from '@renderer/lib/task-type-meta'
import { projectTaskWindow, type TaskView } from '@renderer/lib/task-views'
import { cn } from '@renderer/lib/utils'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
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
  '3x2': 5,
  '3x3': 8,
  '4x2': 6,
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
}

function spanKey(viewport: DashboardTileViewport): string {
  return `${viewport.span.w}x${viewport.span.h}`
}

function rowLimit(viewport: DashboardTileViewport): number {
  return ROW_LIMITS[spanKey(viewport)] ?? 4
}

function rowHeightClass(viewport: DashboardTileViewport): string {
  switch (spanKey(viewport)) {
    case '2x1':
      return 'h-6'
    case '3x2':
    case '4x2':
      return 'h-8'
    case '3x3':
      return 'h-9'
    default:
      return 'h-10'
  }
}

function rowVerticalPaddingClass(viewport: DashboardTileViewport): string {
  switch (spanKey(viewport)) {
    case '2x2':
    case '2x3':
      return 'py-1'
    default:
      return 'py-0.5'
  }
}

function bodyTopPaddingClass(viewport: DashboardTileViewport): string {
  if (viewport.contentLevel === 'summary') return ''
  return spanKey(viewport) === '4x2' ? 'pt-1' : 'pt-2'
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0
  return Math.min(100, Math.max(0, progress * 100))
}

function formatEta(seconds: number, locale: string): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'

  let value: number
  let unit: 'second' | 'minute' | 'hour'
  if (seconds < 60) {
    value = Math.ceil(seconds)
    unit = 'second'
  } else if (seconds < 3600) {
    value = Math.ceil(seconds / 60)
    unit = 'minute'
  } else {
    value = Math.ceil(seconds / 3600)
    unit = 'hour'
  }

  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit,
    unitDisplay: 'narrow',
  }).format(value)
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

function TaskRow({
  task,
  view,
  summary,
  engineOnline,
  now,
  heightClass,
  verticalPaddingClass,
  onOpen,
  onFocusedRowRemoved,
}: {
  task: DownloadTask
  view: TaskView
  summary: boolean
  engineOnline: boolean
  now: number
  heightClass: string
  verticalPaddingClass: string
  onOpen(task: DownloadTask): void
  onFocusedRowRemoved(): void
}) {
  const { t, i18n } = useTranslation()
  const descriptionId = useId()
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const statusLabel = taskStatusLabel(task.status, t)
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
      secondary: t('panel.dashboard.tasks.secondary.failed', {
        reason: failure.reason,
      }),
      progress: null,
    }
  } else if (view === 'recent') {
    const finalSize =
      task.sizeWhenDone > 0 ? task.sizeWhenDone : task.totalBytes
    presentation = {
      primary: formatBytes(finalSize),
      secondary: t('panel.dashboard.tasks.secondary.completed', {
        time: formatRelativeTime(terminalDisplayTime(task), now, i18n.language),
      }),
      progress: null,
    }
  } else {
    switch (task.status) {
      case TaskStatus.Downloading:
        presentation = {
          primary: engineOnline ? `${formatBytes(task.downloadSpeed)}/s` : '—',
          secondary: engineOnline
            ? `${statusLabel} · ${t('panel.dashboard.tasks.secondary.eta', {
                time: formatEta(task.etaSeconds, i18n.language),
              })}`
            : t('panel.dashboard.tasks.secondary.offline'),
          progress: clampProgress(task.progress),
        }
        break
      case TaskStatus.FetchingMetadata:
        presentation = {
          primary: t('panel.dashboard.tasks.metric.fetching'),
          secondary: engineOnline
            ? t('panel.dashboard.tasks.secondary.metadata')
            : t('panel.dashboard.tasks.secondary.offline'),
          progress: null,
        }
        break
      case TaskStatus.MetadataReady:
        presentation = {
          primary: t('panel.dashboard.tasks.metric.ready'),
          secondary: engineOnline
            ? t('panel.dashboard.tasks.secondary.chooseFiles')
            : t('panel.dashboard.tasks.secondary.offline'),
          progress: null,
        }
        break
      case TaskStatus.Finalizing:
        presentation = {
          primary: t('panel.dashboard.tasks.metric.finalizing'),
          secondary: engineOnline
            ? t('panel.dashboard.tasks.secondary.finalizing')
            : t('panel.dashboard.tasks.secondary.offline'),
          progress: null,
        }
        break
      case TaskStatus.Seeding:
        presentation = {
          primary: engineOnline ? `${formatBytes(task.uploadSpeed)}/s` : '—',
          secondary: engineOnline
            ? task.bt
              ? `${statusLabel} · ${t('panel.dashboard.tasks.secondary.ratio', {
                  ratio: task.bt.ratio.toFixed(2),
                })}`
              : statusLabel
            : t('panel.dashboard.tasks.secondary.offline'),
          progress: null,
        }
        break
      case TaskStatus.Queued:
        presentation = {
          primary: t('panel.dashboard.tasks.metric.queued'),
          secondary: engineOnline
            ? t('panel.dashboard.tasks.secondary.waiting')
            : t('panel.dashboard.tasks.secondary.offline'),
          progress: null,
        }
        break
      case TaskStatus.Paused:
        presentation = {
          primary: t('panel.dashboard.tasks.metric.paused'),
          secondary: engineOnline
            ? t('panel.dashboard.tasks.secondary.saved', {
                percent: Math.round(clampProgress(task.progress)),
              })
            : t('panel.dashboard.tasks.secondary.offline'),
          progress: null,
        }
        break
      default:
        presentation = {
          primary: statusLabel,
          secondary: statusLabel,
          progress: null,
        }
    }
  }

  const setButtonRef = useCallback(
    (element: HTMLButtonElement | null) => {
      const previous = buttonRef.current
      if (
        element === null &&
        previous !== null &&
        document.activeElement === previous
      ) {
        onFocusedRowRemoved()
      }
      buttonRef.current = element
    },
    [onFocusedRowRemoved]
  )
  const Icon = TASK_TYPE_META[task.type].icon
  const accessibleName = `${task.name}, ${statusLabel}`
  const accessibleDescription = technicalDetail
    ? `${presentation.primary}. ${presentation.secondary}. ${t(
        'panel.dashboard.tasks.secondary.technicalDetail',
        { detail: technicalDetail }
      )}`
    : `${presentation.primary}. ${presentation.secondary}`
  const title = technicalDetail ? `${task.name}\n${technicalDetail}` : task.name

  return (
    <li className={cn('min-w-0 shrink-0 px-1', heightClass)}>
      {/* biome-ignore lint/a11y/useSemanticElements: The spec requires a named row group around one full-row interactive button and its sibling progress indicator. */}
      <div
        role="group"
        aria-label={task.name}
        className="relative h-full min-w-0"
      >
        <button
          ref={setButtonRef}
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
            className="pointer-events-none relative z-10 flex h-full min-w-0 items-center gap-2 px-1 text-[12px] leading-none"
          >
            <span className="min-w-0 flex-1 truncate font-medium">
              {task.name}
            </span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {presentation.primary}
            </span>
          </div>
        ) : (
          <div
            aria-hidden
            className={cn(
              'pointer-events-none relative z-10 grid h-full min-w-0 grid-cols-[14px_minmax(0,1fr)_auto] grid-rows-2 items-center gap-x-2 px-1',
              verticalPaddingClass,
              presentation.progress !== null && 'pb-1.5'
            )}
          >
            <Icon className="row-span-2 size-3.5 text-muted-foreground" />
            <span className="min-w-0 truncate text-[12px] font-medium leading-[13px]">
              {task.name}
            </span>
            <span className="shrink-0 text-[11px] leading-[13px] text-muted-foreground tabular-nums">
              {presentation.primary}
            </span>
            <span className="col-span-2 min-w-0 truncate text-[10px] leading-[11px] text-muted-foreground">
              {presentation.secondary}
            </span>
          </div>
        )}

        <span id={descriptionId} className="sr-only">
          {accessibleDescription}
        </span>

        {!summary && presentation.progress !== null ? (
          <Progress
            value={presentation.progress}
            aria-label={t('panel.dashboard.tasks.progressLabel', {
              name: task.name,
            })}
            className="pointer-events-none absolute right-1 bottom-0.5 left-[26px] z-10 h-0.5 w-auto rounded-full"
          />
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
  const verticalPaddingClass = rowVerticalPaddingClass(viewport)

  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {t('panel.dashboard.tasks.loading')}
      </span>
      <ul
        aria-busy="true"
        aria-label={t('panel.dashboard.tasks.loading')}
        className={cn('flex min-h-0 flex-1 flex-col', !summary && 'gap-1')}
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
              <div
                className={cn(
                  'grid w-full grid-cols-[14px_1fr_auto] items-center gap-x-2 px-1',
                  verticalPaddingClass
                )}
              >
                <Skeleton className="size-3.5 rounded-sm" />
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
  const verticalPaddingClass = rowVerticalPaddingClass(viewport)
  const topPaddingClass = bodyTopPaddingClass(viewport)
  const projection = useMemo(
    () => projectTaskWindow(source.tasks, view, limit),
    [source.tasks, view, limit]
  )
  const hasOverflow = projection.total > limit
  const visibleRows = hasOverflow
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
                + {t('panel.dashboard.tasks.newTask')}
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
        className={cn('flex min-h-0 flex-1 flex-col', !summary && 'gap-1')}
      >
        {visibleRows.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            view={view}
            summary={summary}
            engineOnline={online}
            now={displayNow}
            heightClass={heightClass}
            verticalPaddingClass={verticalPaddingClass}
            onOpen={openTask}
            onFocusedRowRemoved={focusSelectedSegment}
          />
        ))}
        {hasOverflow ? (
          <li className={cn('min-w-0 shrink-0 px-1', heightClass)}>
            <button
              type="button"
              data-testid="tasks-more"
              onClick={() => navigate(routeForView)}
              className={cn(
                'flex h-full w-full items-center rounded-md pr-1 text-left text-[11px] leading-none font-medium text-muted-foreground outline-none transition-colors hover:bg-accent/45 hover:text-foreground focus-visible:bg-accent/45 focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none',
                summary ? 'pl-1' : 'pl-[26px]'
              )}
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
      bodyClassName={cn('min-h-0', topPaddingClass)}
    >
      {content}
    </TileShell>
  )
}
