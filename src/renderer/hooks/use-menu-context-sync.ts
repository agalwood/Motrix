import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import type { MenuContext } from '@shared/types/menu-context'
import { useEffect, useRef } from 'react'
import { useCurrentRoute } from './use-current-route'
import { useSelectedTask } from './use-selected-task'
import { useTaskList } from './use-task-list'

type Patch = Partial<MenuContext>

const RETRY_DELAY_MS = 500

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
  const acknowledged = useRef<Patch>({})
  const desired = useRef<Patch>({})
  const drainOutbox = useRef<() => void>(() => {})

  useEffect(() => {
    if (__MOTRIX_TARGET__ !== 'electron') return

    let disposed = false
    let inFlight = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const clearRetry = (): void => {
      if (retryTimer === null) return
      clearTimeout(retryTimer)
      retryTimer = null
    }

    const scheduleRetry = (): void => {
      if (disposed || retryTimer !== null) return
      retryTimer = setTimeout(() => {
        retryTimer = null
        drain()
      }, RETRY_DELAY_MS)
    }

    const drain = (): void => {
      if (disposed || inFlight || retryTimer !== null) return

      const patch = diff(acknowledged.current, desired.current)
      if (Object.keys(patch).length === 0) return

      inFlight = true
      void (async () => {
        try {
          await transport.invoke(Commands.UpdateMenuContext, patch)
        } catch {
          if (disposed) return
          inFlight = false
          scheduleRetry()
          return
        }

        if (disposed) return
        acknowledged.current = { ...acknowledged.current, ...patch }
        inFlight = false
        drain()
      })()
    }

    drainOutbox.current = drain
    drain()

    return () => {
      disposed = true
      clearRetry()
      drainOutbox.current = () => {}
    }
  }, [])

  useEffect(() => {
    if (__MOTRIX_TARGET__ !== 'electron') return

    desired.current = {
      selectedTaskId: selected.task?.id ?? null,
      selectedTaskStatus: selected.task?.status ?? null,
      selectedTaskAtTop: selected.atTop,
      selectedTaskAtBottom: selected.atBottom,
      hasAnyActiveTask: list.hasAnyActive,
      hasAnyPausedTask: list.hasAnyPaused,
      hasStoppedTasks: list.hasStopped,
      currentRoute: route,
    }
    drainOutbox.current()
  }, [selected, list, route])
}
