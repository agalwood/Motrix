import { PanelShell } from '@renderer/components/desktop-kit/panel/panel-shell'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useTaskList } from '@renderer/hooks/use-task-list'
import type { DownloadTask, TaskType } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router'
import {
  applyFilter,
  countTasksByTab,
  countTasksByType,
  type DownloadsTab,
  isValidTab,
  parseTypeParam,
  serializeTypeParam,
  taskMatchesTab,
} from './filter'
import { FilterSearchCommand } from './filter-search-command'
import { GlobalStatsBar } from './global-stats-bar'
import { StatusTitleMenu } from './status-title-menu'
import { useDownloadsSelection } from './store'
import { TaskInspectorDrawer } from './task-inspector-drawer'
import { TaskListPanel } from './task-list-panel'

interface ActiveDeepLink {
  signature: string
  taskId: string
}

const SKELETON_ROW_IDS = ['one', 'two', 'three', 'four', 'five', 'six']

function TaskListSkeleton() {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t('common.loading')}
      data-testid="downloads-loading"
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border"
    >
      <div className="flex h-9 shrink-0 items-center gap-6 border-b border-border px-3">
        <Skeleton className="h-3 w-1/3" />
        <Skeleton className="ml-auto h-3 w-16" />
      </div>
      <div className="flex flex-col gap-4 px-3 py-4">
        {SKELETON_ROW_IDS.map((id) => (
          <div key={id} className="flex h-8 items-center gap-3">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="ml-auto h-3 w-20" />
          </div>
        ))}
      </div>
    </div>
  )
}

function TaskListUnavailable({ onRetry }: { onRetry(): void }) {
  const { t } = useTranslation()
  return (
    <div
      role="alert"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-10 text-center"
    >
      <p className="text-sm font-medium text-foreground">
        {t('panel.downloads.empty.unavailable')}
      </p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        {t('panel.downloads.action.retry')}
      </Button>
    </div>
  )
}

/** Slim in-place notice for the silent failure mode: a ready snapshot keeps
 *  the list rendered, so a failed resync would otherwise be invisible while
 *  the rows on screen may miss removals/terminal transitions. */
function TaskListStaleBanner({ onRetry }: { onRetry(): void }) {
  const { t } = useTranslation()
  return (
    <div
      data-testid="downloads-stale-banner"
      role="status"
      className="flex shrink-0 items-center justify-between gap-3 rounded-md border border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground"
    >
      <span>{t('panel.downloads.stale.banner')}</span>
      <Button size="sm" variant="outline" onClick={onRetry}>
        {t('panel.downloads.action.retry')}
      </Button>
    </div>
  )
}

export function DownloadsPage() {
  const { filter: rawFilter } = useParams<{ filter: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const filter: DownloadsTab = isValidTab(rawFilter) ? rawFilter : 'all'

  useEffect(() => {
    if (rawFilter && !isValidTab(rawFilter)) {
      navigate('/downloads/all', { replace: true })
    }
  }, [rawFilter, navigate])

  const { tasks, status, hasReadySnapshot, retry } = useTaskList()
  const types = useMemo(
    () => parseTypeParam(searchParams.get('type')),
    [searchParams]
  )
  const taskParam = searchParams.get('task')?.trim() || null
  const deepLinkSignature = `${location.key}:${location.pathname}${location.search}`

  const counts = useMemo(() => countTasksByTab(tasks), [tasks])
  const typeCounts = useMemo(() => countTasksByType(tasks), [tasks])
  const filtered = useMemo(
    () => applyFilter(tasks, filter, types),
    [tasks, filter, types]
  )

  const onTabChange = useCallback(
    (next: DownloadsTab) => {
      const qs = serializeTypeParam(types)
      navigate(`/downloads/${next}${qs ? `?type=${qs}` : ''}`)
    },
    [navigate, types]
  )

  const onTypesChange = useCallback(
    (next: TaskType[]) => {
      const qs = serializeTypeParam(next)
      const sp = new URLSearchParams(searchParams)
      if (qs) sp.set('type', qs)
      else sp.delete('type')
      sp.delete('task')
      setSearchParams(sp, { replace: true })
    },
    [searchParams, setSearchParams]
  )

  const select = useDownloadsSelection((s) => s.select)
  const clearSelection = useDownloadsSelection((s) => s.clearSelection)
  const consumedDeepLinks = useRef(new Set<string>())
  const activeDeepLink = useRef<ActiveDeepLink | null>(null)
  const handlingDeepLinkSelection = useRef(false)

  const removeTaskQuery = useCallback(() => {
    const active = activeDeepLink.current
    if (active) consumedDeepLinks.current.add(active.signature)
    activeDeepLink.current = null

    if (!searchParams.has('task')) return
    const next = new URLSearchParams(searchParams)
    next.delete('task')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  useLayoutEffect(() => {
    if (!taskParam) {
      activeDeepLink.current = null
      return
    }
    if (activeDeepLink.current?.signature === deepLinkSignature) return

    activeDeepLink.current = {
      signature: deepLinkSignature,
      taskId: taskParam,
    }
    handlingDeepLinkSelection.current = true
    clearSelection()
    handlingDeepLinkSelection.current = false
  }, [clearSelection, deepLinkSignature, taskParam])

  useEffect(
    () =>
      useDownloadsSelection.subscribe((next, previous) => {
        if (
          handlingDeepLinkSelection.current ||
          next.committedSelectedIds === previous.committedSelectedIds ||
          activeDeepLink.current === null
        ) {
          return
        }
        removeTaskQuery()
      }),
    [removeTaskQuery]
  )

  useEffect(() => {
    if (
      !taskParam ||
      consumedDeepLinks.current.has(deepLinkSignature) ||
      !hasReadySnapshot
    ) {
      return
    }

    const target = tasks.find(
      (task) => task.id === taskParam && task.status !== TaskStatus.Removed
    )
    if (!target) {
      consumedDeepLinks.current.add(deepLinkSignature)
      return
    }

    const matchesType = types.length === 0 || types.includes(target.type)
    if (!taskMatchesTab(target, filter) || !matchesType) {
      consumedDeepLinks.current.add(deepLinkSignature)
      const next = new URLSearchParams(searchParams)
      next.set('task', target.id)
      next.delete('type')
      navigate(
        {
          pathname: '/downloads/all',
          search: next.toString() ? `?${next.toString()}` : '',
        },
        { replace: true }
      )
      return
    }

    consumedDeepLinks.current.add(deepLinkSignature)
    handlingDeepLinkSelection.current = true
    select(target.id)
    handlingDeepLinkSelection.current = false
  }, [
    deepLinkSignature,
    filter,
    hasReadySnapshot,
    navigate,
    searchParams,
    select,
    taskParam,
    tasks,
    types,
  ])

  const onOpenTask = useCallback(
    (task: DownloadTask) => {
      removeTaskQuery()
      if (!taskMatchesTab(task, filter)) {
        const qs = serializeTypeParam(types)
        navigate(`/downloads/all${qs ? `?type=${qs}` : ''}`)
      }
      // select() sets selectedIds immediately so the inspector opens. When we
      // just navigated to /downloads/all, focusedIndex re-resolves on the next
      // list render (setItems) — the drawer only needs selectedIds to be set.
      select(task.id)
    },
    [filter, types, navigate, removeTaskQuery, select]
  )

  const [container, setContainer] = useState<HTMLElement | null>(null)
  const taskList =
    status === 'loading' ? (
      <TaskListSkeleton />
    ) : status === 'error' && !hasReadySnapshot ? (
      <TaskListUnavailable onRetry={() => void retry()} />
    ) : (
      <TaskListPanel
        tasks={filtered}
        hasAnyTasks={counts.all > 0}
        selection={useDownloadsSelection}
        filter={filter}
        search=""
        onClearSearch={() => onTypesChange([])}
      />
    )

  return (
    <div ref={setContainer} className="relative flex h-full flex-col">
      <PanelShell
        title={
          <StatusTitleMenu
            tab={filter}
            onTabChange={onTabChange}
            counts={counts}
          />
        }
        actions={
          <FilterSearchCommand
            tasks={tasks}
            types={types}
            onTypesChange={onTypesChange}
            typeCounts={typeCounts}
            onOpenTask={onOpenTask}
          />
        }
        actionsPosition="end"
        footer={<GlobalStatsBar counts={counts} />}
        contentClassName="px-6"
      >
        {status === 'error' && hasReadySnapshot ? (
          <TaskListStaleBanner onRetry={() => void retry()} />
        ) : null}
        {taskList}
      </PanelShell>
      <TaskInspectorDrawer
        selection={useDownloadsSelection}
        tasks={tasks}
        container={container}
        onDismiss={removeTaskQuery}
      />
    </div>
  )
}
