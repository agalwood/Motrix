import { useCompactHeader } from '@renderer/components/desktop-kit/hooks/use-compact-header'
import type { SelectionStore } from '@renderer/components/desktop-kit/selection/types'
import { ToolbarGlass } from '@renderer/components/desktop-kit/toolbar-glass/toolbar-glass'
import { useLiquidGlass } from '@renderer/hooks/use-liquid-glass'
import type { DownloadTask } from '@shared/types/task'
import { useLayoutEffect, useRef, useState } from 'react'
import {
  FilterSearchCommand,
  type FilterSearchCommandProps,
} from './filter-search-command'
import { InspectorToggle, ListViewMenu } from './list-view-menu'
import { TaskActionsMenu } from './task-actions-menu'

// Match the 30px / 24px targets, 4px gaps and capsule padding in both densities.
const actionWidth = (count: number, compact: boolean) =>
  count * (compact ? 24 : 30) + (count - 1) * 4 + 6
const SEARCH_WIDTH = 230
const GROUP_GAP = 8

export function toolbarActionCount(
  width: number,
  expanded: boolean,
  previous = 3,
  compact = false
): number {
  const searchWidth = expanded ? SEARCH_WIDTH : actionWidth(1, compact)
  for (const count of [3, 2]) {
    // Reserve 8px before restoring an item so resizing near a threshold is stable.
    const reserve = count > previous ? 8 : 0
    if (
      width >=
      actionWidth(count, compact) + GROUP_GAP + searchWidth + reserve
    )
      return count
  }
  return 1
}

export function DownloadsToolbar({
  tasks,
  selection,
  onHideInspector,
  ...searchProps
}: Omit<
  FilterSearchCommandProps,
  'expanded' | 'onExpandedChange' | 'width' | 'glassEnabled'
> & {
  tasks: readonly DownloadTask[]
  selection: SelectionStore<DownloadTask>
  onHideInspector: () => void
}) {
  const compact = useCompactHeader()
  const glassEnabled = useLiquidGlass()
  const rootRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const viewRef = useRef<HTMLButtonElement>(null)
  const inspectorRef = useRef<HTMLButtonElement>(null)
  const [searchRequested, setSearchRequested] = useState(false)
  const expanded =
    searchRequested ||
    Boolean(searchProps.query.trim()) ||
    searchProps.types.length > 0
  const [width, setWidth] = useState(400)
  const [count, setCount] = useState(3)
  const [viewMenuOpen, setViewMenuOpen] = useState(false)

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const measure = () => {
      const available = root.getBoundingClientRect().width
      if (available > 0) setWidth(available)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    // Keep an open menu anchored until it closes. The field can shrink while
    // a user resizes the window with that menu open.
    if (viewMenuOpen) return
    const next = toolbarActionCount(width, expanded, count, compact)
    if (next === count) return
    const focused = document.activeElement
    if (
      (next < 3 && focused === viewRef.current) ||
      (next < 2 && focused === inspectorRef.current)
    ) {
      moreRef.current?.focus({ preventScroll: true })
    }
    setCount(next)
  }, [width, expanded, count, compact, viewMenuOpen])

  return (
    <div
      ref={rootRef}
      data-slot="downloads-toolbar"
      data-density={compact ? 'compact' : 'standard'}
      data-visible-actions={count}
      className="flex min-w-0 flex-1 items-center justify-end gap-2"
    >
      <div
        data-slot="downloads-action-group"
        className="toolbar-glass-surface flex h-9 shrink-0 items-center gap-1 rounded-full border border-border/70 bg-background/70 p-0.5 compact-header:h-[30px]"
      >
        <ToolbarGlass enabled={glassEnabled} />
        <TaskActionsMenu
          tasks={tasks}
          selection={selection}
          onHideInspector={onHideInspector}
          triggerRef={moreRef}
        />
        {count === 3 && (
          <ListViewMenu triggerRef={viewRef} onOpenChange={setViewMenuOpen} />
        )}
        {count >= 2 && (
          <InspectorToggle triggerRef={inspectorRef} onHide={onHideInspector} />
        )}
      </div>
      <FilterSearchCommand
        {...searchProps}
        glassEnabled={glassEnabled}
        expanded={expanded}
        onExpandedChange={setSearchRequested}
        width={Math.max(
          80,
          Math.min(
            SEARCH_WIDTH,
            width - actionWidth(count, compact) - GROUP_GAP
          )
        )}
      />
    </div>
  )
}
