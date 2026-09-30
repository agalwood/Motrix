import { PanelShell } from '@renderer/components/desktop-kit/panel/panel-shell'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useTaskList } from '@renderer/hooks/use-task-list'
import { isTaskAvailable, resolveTaskRoute } from '@shared/lib/task-navigation'
import type { TaskType } from '@shared/types/task'
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
import { DownloadsToolbar } from './downloads-toolbar'
import {
  applyFilter,
  countTasksByTab,
  countTasksByType,
  type DownloadsTab,
  isValidTab,
  parseTypeParam,
  serializeTypeParam,
  taskMatchesQuery,
  taskMatchesTab,
} from './filter'
import { GlobalStatsBar } from './global-stats-bar'
import { resolveInspectorInset } from './inspector-inset'
import { StatusTitleMenu } from './status-title-menu'
import { useDownloadsSelection } from './store'
import { TaskInspectorDrawer } from './task-inspector-drawer'
import { TaskListPanel } from './task-list-panel'
import { useDownloadsView } from './view-preferences'

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
        <Skeleton className="ms-auto h-3 w-16" />
      </div>
      <div className="flex flex-col gap-4 px-3 py-4">
        {SKELETON_ROW_IDS.map((id) => (
          <div key={id} className="flex h-8 items-center gap-3">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="ms-auto h-3 w-20" />
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
  const query = searchParams.get('q') ?? ''
  const taskParam = searchParams.get('task')?.trim() || null
  const deepLinkSignature = `${location.key}:${location.pathname}${location.search}`

  const counts = useMemo(() => countTasksByTab(tasks), [tasks])
  const typeCounts = useMemo(
    () =>
      countTasksByType(
        tasks.filter(
          (task) =>
            taskMatchesTab(task, filter) && taskMatchesQuery(task, query)
        )
      ),
    [tasks, filter, query]
  )
  const filtered = useMemo(
    () => applyFilter(tasks, filter, types, query),
    [tasks, filter, types, query]
  )

  const onTabChange = useCallback(
    (next: DownloadsTab) => {
      const nextParams = new URLSearchParams(searchParams)
      nextParams.delete('task')
      navigate(`/downloads/${next}${nextParams.size ? `?${nextParams}` : ''}`)
    },
    [navigate, searchParams]
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

  const onQueryChange = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams)
      if (next) params.set('q', next)
      else params.delete('q')
      params.delete('task')
      setSearchParams(params, { replace: true })
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
      (task) => task.id === taskParam && isTaskAvailable(task.status)
    )
    if (!target) {
      consumedDeepLinks.current.add(deepLinkSignature)
      useDownloadsView.getState().setInspectorVisible(false)
      navigate(resolveTaskRoute(taskParam, undefined), { replace: true })
      return
    }

    const matchesType = types.length === 0 || types.includes(target.type)
    if (
      !taskMatchesTab(target, filter) ||
      !matchesType ||
      !taskMatchesQuery(target, query)
    ) {
      consumedDeepLinks.current.add(deepLinkSignature)
      const next = new URLSearchParams(searchParams)
      next.set('task', target.id)
      next.delete('type')
      next.delete('q')
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
    useDownloadsView.getState().setInspectorVisible(true)
    handlingDeepLinkSelection.current = false
  }, [
    deepLinkSignature,
    filter,
    query,
    hasReadySnapshot,
    navigate,
    searchParams,
    select,
    taskParam,
    tasks,
    types,
  ])

  const [container, setContainer] = useState<HTMLElement | null>(null)
  const taskListKey = `${filter}:${serializeTypeParam(types)}`

  // The inspector drawer overlays the page root without resizing the list, so
  // the list must reserve scroll space for the band the drawer covers;
  // otherwise rows in that band (typically the active ones, sorted last) can
  // never scroll above the drawer's top edge.
  const inspectorVisible = useDownloadsView((state) => state.inspectorVisible)
  const inspectorSnap = useDownloadsView((state) => state.inspectorSnap)
  const committedIds = useDownloadsSelection(
    (state) => state.committedSelectedIds
  )
  // Mirror useTaskInspectorState's open condition so scroll space is only
  // reserved while the drawer actually overlays the page.
  const inspectorOpen = useMemo(
    () =>
      inspectorVisible &&
      tasks.some(
        (task) => committedIds.has(task.id) && isTaskAvailable(task.status)
      ),
    [committedIds, inspectorVisible, tasks]
  )
  const [inspectorMetrics, setInspectorMetrics] = useState({
    page: 0,
    footer: 0,
    grid: 0,
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebind when loading/empty states or the keyed task panel replace the observed elements without resizing the page root
  useEffect(() => {
    if (!container) return
    const footerElement = container.querySelector<HTMLElement>(
      '[data-slot="panel-shell-footer"]'
    )
    const gridElement = container.querySelector<HTMLElement>(
      '[data-downloads-grid]'
    )
    const measure = () => {
      const page = container.getBoundingClientRect().height
      const footer = footerElement?.getBoundingClientRect().height ?? 0
      const grid = gridElement?.getBoundingClientRect().height ?? 0
      setInspectorMetrics((previous) =>
        previous.page === page &&
        previous.footer === footer &&
        previous.grid === grid
          ? previous
          : { page, footer, grid }
      )
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    // Header animations and footer content can resize the grid after the
    // bounded page root has stopped resizing.
    if (footerElement) observer.observe(footerElement)
    if (gridElement) observer.observe(gridElement)
    return () => observer.disconnect()
  }, [container, status, hasReadySnapshot, filtered.length, taskListKey])
  const inspectorInset = resolveInspectorInset({
    pageHeight: inspectorMetrics.page,
    footerHeight: inspectorMetrics.footer,
    gridHeight: inspectorMetrics.grid,
    snap: inspectorSnap,
    open: inspectorOpen,
  })

  const taskList =
    status === 'loading' && !hasReadySnapshot ? (
      <TaskListSkeleton />
    ) : status === 'error' && !hasReadySnapshot ? (
      <TaskListUnavailable onRetry={() => void retry()} />
    ) : (
      <TaskListPanel
        key={taskListKey}
        tasks={filtered}
        hasAnyTasks={counts.all > 0}
        selection={useDownloadsSelection}
        filter={filter}
        search={query}
        onClearSearch={() => onQueryChange('')}
        bottomInset={inspectorInset}
      />
    )

  return (
    <div
      ref={setContainer}
      className="relative flex h-full min-h-0 flex-col overflow-hidden"
    >
      <div className="min-h-0 flex-1">
        <PanelShell
          title={
            <StatusTitleMenu
              tab={filter}
              onTabChange={onTabChange}
              counts={counts}
              visibleCount={filtered.length}
            />
          }
          actions={
            <DownloadsToolbar
              tasks={tasks}
              selection={useDownloadsSelection}
              query={query}
              onQueryChange={onQueryChange}
              types={types}
              onTypesChange={onTypesChange}
              typeCounts={typeCounts}
              onHideInspector={removeTaskQuery}
            />
          }
          actionsPosition="end"
          actionsDraggable
          headerClassName="compact-header:py-1"
          actionsClassName="min-w-0 flex-1"
          footer={<GlobalStatsBar />}
          contentClassName="px-6"
        >
          {status === 'error' && hasReadySnapshot ? (
            <TaskListStaleBanner onRetry={() => void retry()} />
          ) : null}
          {taskList}
        </PanelShell>
      </div>
      <TaskInspectorDrawer
        selection={useDownloadsSelection}
        tasks={tasks}
        container={container}
        onDismiss={removeTaskQuery}
      />
    </div>
  )
}
