import { registerDownloadsMenuContext } from '@renderer/features/application-menu/task-context'
import './downloads-list.css'
import { useSelectableList } from '@renderer/components/desktop-kit/hooks/use-selectable-list'
import { MarqueeOverlay } from '@renderer/components/desktop-kit/marquee-selection/marquee-overlay'
import type { SelectionStore } from '@renderer/components/desktop-kit/selection/types'
import { VirtualList } from '@renderer/components/desktop-kit/virtual-list/virtual-list'
import { useIpcEvent } from '@renderer/hooks/use-ipc-event'
import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import type { DownloadTask } from '@shared/types/task'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TASK_HEADER_HEIGHT, TASK_ROW_HEIGHT } from './columns'
import { EmptyTasks } from './empty-tasks'
import type { DownloadsTab } from './filter'
import { sortTasks } from './sort'
import { useDownloadsSort } from './store'
import { TaskActionsMenu } from './task-actions-menu'
import { TaskColumnHeader } from './task-column-header'
import { TaskRow } from './task-row'
import { useDownloadsView } from './view-preferences'

const TASK_LIST_CONTROL_SELECTOR =
  'button, input, textarea, select, a, [contenteditable="true"], [role="separator"], [role="columnheader"], [data-slot="scroll-area-scrollbar"]'

export interface TaskListPanelProps {
  tasks: readonly DownloadTask[]
  hasAnyTasks: boolean
  selection: SelectionStore<DownloadTask>
  filter: DownloadsTab
  search: string
  onClearSearch: () => void
}

export function TaskListPanel({
  tasks,
  hasAnyTasks,
  selection,
  filter,
  search,
  onClearSearch,
}: TaskListPanelProps) {
  const { t, i18n } = useTranslation()
  const sort = useDownloadsSort((state) => state.sort)
  const toggleSort = useDownloadsSort((state) => state.toggleSort)
  const allColumns = useDownloadsView((state) => state.columns)
  const columns = useMemo(
    () => allColumns.filter((column) => column.visible),
    [allColumns]
  )
  const sorted = useMemo(
    () => sortTasks(tasks, sort, i18n.language),
    [tasks, sort, i18n.language]
  )
  const [frozenIds, setFrozenIds] = useState<string[] | null>(null)
  const displayed = useMemo(() => {
    if (!frozenIds) return sorted as DownloadTask[]
    const latest = new Map(tasks.map((task) => [task.id, task]))
    return frozenIds.flatMap((id) => {
      const task = latest.get(id)
      return task ? [task] : []
    })
  }, [tasks, sorted, frozenIds])
  const gridRef = useRef<HTMLDivElement>(null)
  useEffect(
    () =>
      registerDownloadsMenuContext(
        () => gridRef.current?.focus({ preventScroll: true }),
        `${filter}:${search}`
      ),
    [filter, search]
  )
  const [active, setActive] = useState(false)
  const pointerFocus = useRef(false)
  const [keyboardFocus, setKeyboardFocus] = useState(false)
  const downId = useRef<string | null>(null)
  const suppressClick = useRef(false)
  const lastClickedId = useRef<string | null>(null)
  const prefix = useId()
  const getId = useCallback((task: DownloadTask) => task.id, [])
  const getText = useCallback((task: DownloadTask) => task.name, [])
  const macOS =
    transport.platform === 'darwin' ||
    (transport.platform === 'web' && /Mac|iPhone|iPad/.test(navigator.platform))
  const { listRef, listProps, marqueeProps, getRowProps, onKeyDown } =
    useSelectableList({
      items: displayed,
      getId,
      getText,
      rowHeight: TASK_ROW_HEIGHT,
      headerHeight: TASK_HEADER_HEIGHT,
      store: selection,
      nativeSelection: true,
      macOS,
    })
  const focusedId = selection((state) =>
    state.focusedIndex === null
      ? undefined
      : state.items[state.focusedIndex]?.id
  )
  useIpcEvent(Events.TaskSelectAll, () => {
    if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return
    selection.getState().selectAll()
    window.getSelection()?.removeAllRanges()
    pointerFocus.current = true
    setKeyboardFocus(false)
    gridRef.current?.focus({ preventScroll: true })
  })
  useEffect(() => {
    let releaseTimer: ReturnType<typeof setTimeout> | undefined
    const release = () => {
      // A click follows pointerup; keep its row mapping until that click commits.
      releaseTimer = setTimeout(() => {
        setFrozenIds(null)
        downId.current = null
      }, 0)
    }
    const blur = () => {
      setActive(false)
      setFrozenIds(null)
      downId.current = null
    }
    const focus = () =>
      setActive(Boolean(gridRef.current?.contains(document.activeElement)))
    const keyboard = (event: KeyboardEvent) => {
      // Only Tab changes how focus arrives from outside the list. Escape and
      // command shortcuts must preserve the preceding pointer interaction.
      if (event.key === 'Tab' && !event.isComposing)
        pointerFocus.current = false
    }
    window.addEventListener('keydown', keyboard, true)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    window.addEventListener('blur', blur)
    window.addEventListener('focus', focus)
    return () => {
      clearTimeout(releaseTimer)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      window.removeEventListener('blur', blur)
      window.removeEventListener('focus', focus)
      window.removeEventListener('keydown', keyboard, true)
    }
  }, [])

  if (tasks.length === 0)
    return (
      <TaskActionsMenu tasks={tasks} selection={selection}>
        <div className="flex min-h-0 flex-1 flex-col outline-none">
          <EmptyTasks
            filter={filter}
            search={search}
            hasAnyTasks={hasAnyTasks}
            onClearSearch={onClearSearch}
          />
        </div>
      </TaskActionsMenu>
    )

  return (
    <TaskActionsMenu tasks={tasks} selection={selection}>
      {/* biome-ignore lint/a11y/useSemanticElements: A native table cannot contain the virtualizer positioning wrappers. */}
      <div
        ref={gridRef}
        role="grid"
        aria-label={t('panel.downloads.title')}
        aria-multiselectable="true"
        aria-rowcount={displayed.length + 1}
        aria-colcount={columns.length}
        aria-activedescendant={
          focusedId ? `${prefix}-${encodeURIComponent(focusedId)}` : undefined
        }
        data-downloads-grid
        data-active={active}
        data-keyboard-focus={keyboardFocus}
        tabIndex={0}
        onKeyDown={(event) => {
          // Context menus can leave DOM focus on their trigger. Let Base UI
          // consume Escape/navigation before the list changes selection.
          if (event.currentTarget.hasAttribute('data-popup-open')) return
          if (
            event.target === event.currentTarget &&
            !event.defaultPrevented &&
            !event.nativeEvent.isComposing &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            (event.key === 'ArrowUp' ||
              event.key === 'ArrowDown' ||
              event.key.length === 1)
          ) {
            // Reveal focus for row navigation and typeahead, not cancellation.
            pointerFocus.current = false
            setKeyboardFocus(true)
          }
          onKeyDown(event)
        }}
        onFocusCapture={(event) => {
          setActive(true)
          if (event.target === event.currentTarget)
            setKeyboardFocus(
              !pointerFocus.current &&
                event.currentTarget.matches(':focus-visible')
            )
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget))
            setActive(false)
        }}
        onPointerDownCapture={(event) => {
          pointerFocus.current = true
          setKeyboardFocus(false)
          if (event.button !== 0 || (macOS && event.ctrlKey)) return
          if ((event.target as Element).closest(TASK_LIST_CONTROL_SELECTOR))
            return
          suppressClick.current = false
          downId.current =
            (event.target as Element).closest<HTMLElement>('[data-task-id]')
              ?.dataset.taskId ?? null
          setFrozenIds(displayed.map(getId))
          event.currentTarget.focus({ preventScroll: true })
        }}
        onMouseDownCapture={(event) => {
          const target = event.target as Element
          if (
            marqueeProps.containerRef.current?.contains(target) &&
            !target.closest(TASK_LIST_CONTROL_SELECTOR)
          ) {
            // The grid owns keyboard focus through aria-activedescendant;
            // cells and viewport whitespace must not take focus from it.
            event.preventDefault()
          }
        }}
        onClickCapture={(event) => {
          lastClickedId.current = null
          const target = event.target as Element
          const id =
            target.closest<HTMLElement>('[data-task-id]')?.dataset.taskId
          if (
            suppressClick.current ||
            (downId.current && id && id !== downId.current)
          ) {
            event.preventDefault()
            event.stopPropagation()
            suppressClick.current = false
            return
          }
          if (
            id &&
            event.button === 0 &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey &&
            !target.closest(TASK_LIST_CONTROL_SELECTOR)
          )
            lastClickedId.current = id
          if (
            !id &&
            event.button === 0 &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            marqueeProps.containerRef.current?.contains(target) &&
            !target.closest(TASK_LIST_CONTROL_SELECTOR)
          ) {
            selection.getState().clearSelection()
          }
        }}
        onDoubleClick={(event) => {
          const target = event.target as Element
          const id =
            target.closest<HTMLElement>('[data-task-id]')?.dataset.taskId
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey ||
            target.closest(TASK_LIST_CONTROL_SELECTOR) ||
            !id ||
            id !== lastClickedId.current ||
            !tasks.some((task) => task.id === id)
          )
            return
          selection.getState().select(id)
          useDownloadsView.getState().setInspectorVisible(true)
        }}
        className="downloads-task-grid relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border outline-none"
      >
        <VirtualList
          ref={listRef}
          {...listProps}
          scrollbar="custom"
          keepMountedIndex={
            focusedId
              ? displayed.findIndex((task) => task.id === focusedId)
              : undefined
          }
          className="min-h-0 flex-1"
          renderHeader={() => (
            <TaskColumnHeader
              columns={columns}
              sort={sort}
              onSort={toggleSort}
            />
          )}
          renderRow={({ item, index }) => (
            <TaskRow
              id={`${prefix}-${encodeURIComponent(item.id)}`}
              task={item}
              columns={columns}
              index={index}
              rowProps={getRowProps(index)}
            />
          )}
          renderEmpty={() => null}
        />
        <MarqueeOverlay
          {...marqueeProps}
          onSelectionEnd={() => {
            suppressClick.current = true
            marqueeProps.onSelectionEnd()
          }}
        />
      </div>
    </TaskActionsMenu>
  )
}
