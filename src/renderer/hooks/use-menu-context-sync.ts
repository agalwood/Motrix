import {
  menuContextPatch,
  subscribeMenuContext,
} from '@renderer/features/application-menu/task-context'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import type { MenuContext } from '@shared/types/menu-context'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useCurrentRoute } from './use-current-route'

type Patch = Partial<MenuContext>

const RETRY_DELAY_MS = 500

function diff(prev: Patch, next: Patch): Patch {
  const out: Patch = {}
  let changed = false
  for (const key of Object.keys(next) as (keyof MenuContext)[]) {
    if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
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
  const signature = useSyncExternalStore(subscribeMenuContext, () =>
    JSON.stringify(menuContextPatch())
  )
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
      ...JSON.parse(signature),
      currentRoute: route,
    }
    drainOutbox.current()
  }, [signature, route])
}
