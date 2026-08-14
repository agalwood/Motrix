import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  type ApplicationMenuSnapshot,
  applicationMenuSnapshotSchema,
  type ExecuteApplicationMenuItemRequest,
} from '@shared/schemas/application-menu'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface ApplicationMenuState {
  snapshot: ApplicationMenuSnapshot | null
  refresh: () => Promise<void>
  executeItem: (request: ExecuteApplicationMenuItemRequest) => Promise<void>
}

function supportsRendererApplicationMenu(): boolean {
  return (
    __MOTRIX_TARGET__ === 'electron' &&
    (transport.platform === 'win32' ||
      transport.platform === 'linux' ||
      (transport.platform === 'darwin' && __MOTRIX_PREVIEW_MAC_MENU__))
  )
}

/**
 * Mirrors the main-process application menu for the Windows/Linux renderer.
 * The event listener is installed before the initial query and revisions can
 * only move forward, so a slow query cannot overwrite a newer pushed snapshot.
 */
export function useApplicationMenu(): ApplicationMenuState {
  const [snapshot, setSnapshot] = useState<ApplicationMenuSnapshot | null>(null)
  const snapshotRef = useRef<ApplicationMenuSnapshot | null>(null)
  const activeRef = useRef(false)

  const applySnapshot = useCallback((value: unknown) => {
    const parsed = applicationMenuSnapshotSchema.safeParse(value)
    if (!parsed.success || !activeRef.current) return

    const currentRevision = snapshotRef.current?.revision ?? -1
    if (parsed.data.revision < currentRevision) return

    snapshotRef.current = parsed.data
    setSnapshot(parsed.data)
  }, [])

  const refresh = useCallback(async () => {
    if (!supportsRendererApplicationMenu()) return
    try {
      applySnapshot(await transport.invoke(Queries.GetApplicationMenu))
    } catch {
      // A menu-open refresh or the next change event will retry.
    }
  }, [applySnapshot])

  const executeItem = useCallback(
    async (request: ExecuteApplicationMenuItemRequest) => {
      if (!supportsRendererApplicationMenu()) return
      try {
        await transport.invoke(Commands.ExecuteApplicationMenuItem, request)
      } catch {
        // Never auto-retry an action: it may be destructive. Refresh instead
        // so the next deliberate interaction uses the current revision.
        await refresh()
      }
    },
    [refresh]
  )

  useEffect(() => {
    if (!supportsRendererApplicationMenu()) return

    activeRef.current = true
    const onChanged = (...args: unknown[]) => {
      applySnapshot(args[0])
    }

    // Subscribe first, then snapshot: a mutation during the query cannot be
    // lost, and the revision guard rejects an older query response afterward.
    transport.on(Events.ApplicationMenuChanged, onChanged)
    void refresh()

    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)

    return () => {
      activeRef.current = false
      transport.off(Events.ApplicationMenuChanged, onChanged)
      window.removeEventListener('focus', onFocus)
    }
  }, [applySnapshot, refresh])

  return { snapshot, refresh, executeItem }
}
