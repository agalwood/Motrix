import { useTransportMirror } from '@renderer/hooks/use-transport-mirror'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { AppNotification } from '@shared/types/notification'
import { useCallback, useState } from 'react'

export interface UseNotificationsOptions {
  /**
   * Skip `Queries.ListNotifications` entirely and leave `items` at `[]`.
   * For a consumer that only ever reads `unreadCount` (the sidebar badge,
   * always mounted) this halves the per-refresh IPC cost — one query
   * instead of two, and the list query alone reads up to 100 rows and runs
   * two `JSON.parse` calls per row for `titleParams`/`bodyParams`.
   *
   * Mount-constant: the mirror captures wiring at mount; flipping this
   * later does not trigger a refetch.
   */
  countOnly?: boolean
}

export interface UseNotificationsResult {
  items: AppNotification[]
  unreadCount: number
  markRead: (id: string) => Promise<void>
  markAllRead: () => Promise<void>
  remove: (id: string) => Promise<void>
  clear: () => Promise<void>
  refresh: () => Promise<void>
}

/**
 * Subscribe-then-snapshot binding for the notification center (Task 17),
 * built on `useTransportMirror` (Task 9): the primitive subscribes to
 * `Events.NotificationsChanged` FIRST (triggers a refetch), THEN invokes
 * `load()` — `Queries.ListNotifications` + `Queries.GetUnreadNotificationCount`
 * — for the initial snapshot.
 *
 * `NotificationAdded` always precedes `NotificationsChanged`
 * (`NotificationCenter.notify` emits both), so the `Changed` subscription
 * alone is sufficient and halves refresh traffic. `NotificationAdded`
 * remains subscribed elsewhere (`useNotificationToasts`, the OS bridge) for
 * consumers that specifically need the "added" moment rather than "changed
 * in some way".
 *
 * `{ countOnly: true }` (e.g. `NotificationsNavItem`, the always-mounted
 * sidebar badge) skips the `ListNotifications` invoke and leaves `items`
 * at `[]` — the return shape is unchanged so callers that only destructure
 * `unreadCount` need no other change.
 *
 * Mutations (`markRead`/`markAllRead`/`remove`/`clear`) only invoke the
 * matching `Commands` and rely on the `NotificationsChanged` broadcast the
 * core emits after its own store write to drive the refetch — there is no
 * optimistic local state here.
 *
 * F4/F7 (bounded retry-once on a failed `load()`, and re-snapshot on
 * transport reconnect + window focus) are now the primitive's
 * responsibility — see `useTransportMirror`'s docstring. Still no
 * optimistic state: a failed attempt leaves `items`/`unreadCount` at their
 * last-good value rather than resetting them.
 */
export function useNotifications(
  options: UseNotificationsOptions = {}
): UseNotificationsResult {
  const { countOnly = false } = options
  const [items, setItems] = useState<AppNotification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)

  const load = useCallback(
    async (stale: () => boolean) => {
      const list = countOnly
        ? []
        : ((await transport.invoke(
            Queries.ListNotifications
          )) as AppNotification[])
      if (stale()) return
      const count = (await transport.invoke(
        Queries.GetUnreadNotificationCount
      )) as number
      if (stale()) return
      setItems(list)
      setUnreadCount(count)
    },
    [countOnly]
  )

  const { refresh } = useTransportMirror({
    events: [Events.NotificationsChanged],
    load,
  })

  const markRead = useCallback(async (id: string) => {
    await transport.invoke(Commands.MarkNotificationRead, id)
  }, [])

  const markAllRead = useCallback(async () => {
    await transport.invoke(Commands.MarkAllNotificationsRead)
  }, [])

  const remove = useCallback(async (id: string) => {
    await transport.invoke(Commands.DeleteNotification, id)
  }, [])

  const clear = useCallback(async () => {
    await transport.invoke(Commands.ClearNotifications)
  }, [])

  return { items, unreadCount, markRead, markAllRead, remove, clear, refresh }
}
