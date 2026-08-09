import type { Logger } from '@core/logger'
import type { EventChannel } from '@shared/protocol/events'
import { Events } from '@shared/protocol/events'
import type { AppNotification } from '@shared/types/notification'
import { NotificationKinds } from '@shared/types/notification'
import type { MotrixAppSettings } from '@shared/types/settings'
import { Notification } from 'electron'

/** Structural subset of Electron's `BrowserWindow` this bridge needs. */
export interface OsNotificationMainWindow {
  isVisible(): boolean
  isFocused(): boolean
  show(): void
  focus(): void
}

/** Structural subset of Electron's `Notification` this bridge needs. */
export interface OsNotificationHandle {
  show(): void
  on(event: 'click', listener: () => void): void
}

export interface OsNotificationBridgeDeps {
  /** `eventBus.on.bind(eventBus)` */
  subscribe: (
    channel: EventChannel,
    listener: (payload: AppNotification) => void
  ) => void
  getMainWindow: () => OsNotificationMainWindow | null
  getAppSettings: () => MotrixAppSettings
  /** `i18n.t.bind(i18n)` — follows `LocaleCoordinator` language switches. */
  translate: (key: string, params?: Record<string, string>) => string
  /** `(taskId) => eventBus.emit(Events.NavigateTo, '/downloads/all?task=' + taskId)` */
  navigateToTask: (taskId: string) => void
  isSupported?: () => boolean
  createNotification?: (opts: {
    title: string
    body?: string
  }) => OsNotificationHandle
  log: Pick<Logger, 'warn'>
}

function isEnabledForKind(kind: string, settings: MotrixAppSettings): boolean {
  return kind === NotificationKinds.TaskComplete
    ? settings.notifyOnComplete
    : settings.notifyOnError
}

/**
 * Best-effort OS notification bridge (Electron only) — Phase C of the
 * notification-center plan (spec §6). Mirrors `AppNotification` rows onto
 * native OS toasts when the main window is not in the foreground, gated
 * per-kind by the `notifyOnComplete` / `notifyOnError` toggles. `task-error`,
 * `engine-failure`, and any unknown kind all fall back to `notifyOnError`.
 *
 * OS toasts carry no delivery tracking — a dropped/dismissed/unsupported
 * toast never blocks or retries anything; the notification center's stored
 * row (already written before `NotificationAdded` fires) is the durable
 * record. This bridge is a pure side effect on top of it.
 *
 * The subscribed listener's entire body runs inside a try/catch: a throwing
 * step (most likely `createNotification` on an unusual platform) is logged
 * via `log.warn` and swallowed, never re-thrown into the `EventBus` dispatch
 * loop — one bad notification must never take down sibling subscribers.
 */
export function createOsNotificationBridge(deps: OsNotificationBridgeDeps): {
  dispose(): void
} {
  const isSupported = deps.isSupported ?? (() => Notification.isSupported())
  const createNotification =
    deps.createNotification ??
    ((opts: { title: string; body?: string }): OsNotificationHandle =>
      new Notification(opts))

  let disposed = false

  function handle(payload: AppNotification): void {
    const win = deps.getMainWindow()
    const foreground = win == null ? false : win.isVisible() && win.isFocused()
    if (foreground) return

    if (!isEnabledForKind(payload.kind, deps.getAppSettings())) return

    if (!isSupported()) return

    const title = deps.translate(
      payload.titleKey,
      payload.titleParams ?? undefined
    )
    const body =
      payload.bodyKey != null
        ? deps.translate(payload.bodyKey, payload.bodyParams ?? undefined)
        : undefined

    const notification = createNotification(
      body === undefined ? { title } : { title, body }
    )
    notification.on('click', () => {
      // Runs outside handle()'s own try/catch (it fires later, from
      // Electron's Notification emitter, after handle() has already
      // returned) — navigateToTask fans out through EventBus.emit, which
      // has no per-listener isolation, so a throwing downstream listener
      // must be caught here rather than crash the click callback.
      try {
        const clicked = deps.getMainWindow()
        clicked?.show()
        clicked?.focus()
        if (payload.taskId != null) {
          deps.navigateToTask(payload.taskId)
        }
      } catch (err) {
        deps.log.warn({ err }, 'os-notification-bridge: click handler threw')
      }
    })
    notification.show()
  }

  deps.subscribe(Events.NotificationAdded, (payload) => {
    if (disposed) return
    try {
      handle(payload)
    } catch (err) {
      deps.log.warn({ err }, 'os-notification-bridge: listener threw')
    }
  })

  return {
    dispose(): void {
      disposed = true
    },
  }
}
