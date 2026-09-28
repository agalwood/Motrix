import type { Logger } from '@core/logger'
import { isTaskAvailable } from '@shared/lib/task-navigation'
import type { EventChannel } from '@shared/protocol/events'
import { Events } from '@shared/protocol/events'
import type { AppNotification } from '@shared/types/notification'
import { NotificationKinds } from '@shared/types/notification'
import type { MotrixAppSettings } from '@shared/types/settings'
import type { TaskStatus } from '@shared/types/task'
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
  on(event: 'failed', listener: (event: unknown, error: string) => void): void
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

/**
 * Best-effort OS notification bridge (Electron only). Download outcomes
 * follow the selected system notification preference regardless of focus.
 * Other alerts stay background-only, with their existing in-app presentation
 * owning the foreground. `task-error`, `engine-failure`, and unknown kinds
 * all fall back to `notifyOnError`.
 *
 * Unsupported delivery and native failures are logged but never retried;
 * a dropped or dismissed toast never blocks anything. The center's stored
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
    if (!isEnabledForKind(payload.kind, deps.getAppSettings())) return

    const isTaskOutcome =
      payload.kind === NotificationKinds.TaskComplete ||
      payload.kind === NotificationKinds.TaskError
    if (!isTaskOutcome) {
      const win = deps.getMainWindow()
      if (win?.isVisible() && win.isFocused()) return
    }

    const context = {
      notificationId: payload.id,
      kind: payload.kind,
      taskId: payload.taskId,
    }
    if (!isSupported()) {
      deps.log.warn(
        context,
        'os-notification-bridge: native notifications unavailable'
      )
      return
    }

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
    notification.on('failed', (_event, error) => {
      if (disposed) return
      deps.log.warn(
        { ...context, error },
        'os-notification-bridge: native notification failed'
      )
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
