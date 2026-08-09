import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import type { MenuContext } from '@shared/types/menu-context'
import { useEffect, useRef } from 'react'
import { useCurrentRoute } from './use-current-route'
import { useSelectedTask } from './use-selected-task'
import { useTaskList } from './use-task-list'

type Patch = Partial<MenuContext>

function diff(prev: Patch, next: Patch): Patch {
  const out: Patch = {}
  let changed = false
  for (const key of Object.keys(next) as (keyof MenuContext)[]) {
    if (prev[key] !== next[key]) {
      ;(out as Record<string, unknown>)[key] = next[key]
      changed = true
    }
  }
  return changed ? out : {}
}

/**
 * Keep the main-process MenuContext in sync with renderer state.
 * No-op in web builds (Vite define replaces __MOTRIX_TARGET__ with 'web'
 * so the whole effect body is tree-shaken out of the bundle).
 */
export function useMenuContextSync(): void {
  const selected = useSelectedTask()
  const list = useTaskList()
  const route = useCurrentRoute()
  const lastSent = useRef<Patch>({})

  useEffect(() => {
    if (__MOTRIX_TARGET__ !== 'electron') return

    const next: Patch = {
      selectedTaskId: selected.task?.id ?? null,
      selectedTaskStatus: selected.task?.status ?? null,
      selectedTaskAtTop: selected.atTop,
      selectedTaskAtBottom: selected.atBottom,
      hasAnyActiveTask: list.hasAnyActive,
      hasAnyPausedTask: list.hasAnyPaused,
      hasStoppedTasks: list.hasStopped,
      currentRoute: route,
    }

    const patch = diff(lastSent.current, next)
    if (Object.keys(patch).length === 0) return

    lastSent.current = next
    transport.invoke(Commands.UpdateMenuContext, patch).catch(() => {
      // Ignore — preload may not be ready yet; next render retries.
    })
  }, [selected, list, route])
}
