import type { Logger } from '@core/logger'
import type { EventChannel } from '@shared/protocol/events'
import { Events } from '@shared/protocol/events'
import type { AppNotification } from '@shared/types/notification'
import { NotificationKinds } from '@shared/types/notification'
import type { MotrixAppSettings } from '@shared/types/settings'
import { TaskStatus } from '@shared/types/task'
import { Notification } from 'electron'

/** Structural subset of Electron's `BrowserWindow` this bridge needs. */
export interface OsNotificationMainWindow {
  isVisible(): boolean
  isFocused(): boolean
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
  /** Show the main window, recreating it if it was released in the background. */
  showMainWindow: () => void
  getAppSettings: () => MotrixAppSettings
  /** `i18n.t.bind(i18n)` — follows `LocaleCoordinator` language switches. */
  translate: (key: string, params?: Record<string, string>) => string
  /** Read current state: an OS notification may outlive its task. */
  getTaskStatus: (taskId: string) => TaskStatus | null
  /** Navigate once the main window's renderer is ready. */
  navigateToTask: (taskId: string) => void
  navigateToDownloads: () => void
  /** Reveal the task's current output, or its containing directory if missing. */
  revealTaskInFolder: (taskId: string) => Promise<void>
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

function isTaskAvailable(status: TaskStatus | null): boolean {
  return status != null && status !== TaskStatus.Removed
}

/** Resolve again at dispatch time when a released renderer needs to reload. */
export function resolveNotificationTaskRoute(
  taskId: string,
  status: TaskStatus | null
): string {
  return isTaskAvailable(status)
    ? `/downloads/all?task=${encodeURIComponent(taskId)}`
    : '/downloads/all'
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

  async function handleClick(payload: AppNotification): Promise<void> {
    if (disposed) return
    // Native clicks fire after handle() returns, so isolate both asynchronous
    // file-manager failures and errors while showing or navigating the window.
    try {
      if (
        payload.kind === NotificationKinds.TaskComplete &&
        payload.taskId != null &&
        isTaskAvailable(deps.getTaskStatus(payload.taskId))
      ) {
        try {
          await deps.revealTaskInFolder(payload.taskId)
          return
        } catch (err) {
          if (disposed) return
          if (isTaskAvailable(deps.getTaskStatus(payload.taskId))) {
            deps.log.warn(
              { err, taskId: payload.taskId },
              'os-notification-bridge: reveal failed; opening task'
            )
          }
        }
      }

      if (disposed) return
      deps.showMainWindow()
      if (payload.taskId != null) {
        if (isTaskAvailable(deps.getTaskStatus(payload.taskId))) {
          deps.navigateToTask(payload.taskId)
        } else {
          deps.navigateToDownloads()
        }
      }
    } catch (err) {
      deps.log.warn({ err }, 'os-notification-bridge: click handler threw')
    }
  }

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
    notification.on('click', () => handleClick(payload))
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
