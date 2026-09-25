import type { EventBus } from '@core/events/event-bus'
import { subscribeForwardableEvents } from '@core/events/forward-events'
import { type EventChannel, Events } from '@shared/protocol/events'
import type { AppNotification } from '@shared/types/notification'
import type { WindowId } from '@shared/types/window'
import type { WindowManager } from '../window/window-manager'

function sendToWindowWhenReady(
  windowManager: WindowManager,
  id: WindowId,
  channel: EventChannel,
  args: unknown[]
): void {
  windowManager.show(id)
  const win = windowManager.get(id)
  if (!win || win.isDestroyed()) return

  const send = () => {
    setTimeout(() => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...args)
      }
    }, 100)
  }

  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', send)
    return
  }

  send()
}

export function setupEventForwarding(
  eventBus: EventBus,
  windowManager: WindowManager,
  getHiddenNotificationKinds: () => readonly string[] = () => []
): void {
  subscribeForwardableEvents(eventBus, (channel, args) => {
    // Keep the durable event available to the native OS bridge. Only the
    // Electron renderer's transient presentation is filtered here, using
    // current settings synchronously even before the renderer has loaded.
    if (
      channel === Events.NotificationAdded &&
      getHiddenNotificationKinds().includes((args[0] as AppNotification).kind)
    )
      return
    windowManager.broadcast(channel, ...args)
  })

  // Navigation — only the main window has a React Router,
  // so forward directly instead of broadcasting.
  eventBus.on(
    Events.NavigateTo as Parameters<typeof eventBus.on>[0],
    (...args) => {
      sendToWindowWhenReady(windowManager, 'main', Events.NavigateTo, args)
    }
  )

  // Torrent — MagnetFileSelection opens AddTaskWindow with file selection
  eventBus.on(
    Events.MagnetFileSelection as Parameters<typeof eventBus.on>[0],
    (...args) => {
      sendToWindowWhenReady(
        windowManager,
        'add-task',
        Events.MagnetFileSelection,
        args
      )
    }
  )
}
