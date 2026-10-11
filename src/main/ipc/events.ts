import type { EventBus } from '@core/events/event-bus'
import { subscribeForwardableEvents } from '@core/events/forward-events'
import { type EventChannel, Events } from '@shared/protocol/events'
import type { AppNotification } from '@shared/types/notification'
import type { WindowId } from '@shared/types/window'
import type { WindowManager } from '../window/window-manager'

export function setupEventForwarding(
  eventBus: EventBus,
  windowManager: WindowManager,
  getHiddenNotificationKinds: () => readonly string[] = () => [],
  deliver?: (id: WindowId, channel: EventChannel, payload: unknown) => void
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
      windowManager.show('main')
      if (deliver) deliver('main', Events.NavigateTo, args[0])
      else {
        const win = windowManager.get('main')
        if (win && !win.isDestroyed())
          win.webContents.send(Events.NavigateTo, ...args)
      }
    }
  )

  // Torrent — MagnetFileSelection opens AddTaskWindow with file selection
  eventBus.on(
    Events.MagnetFileSelection as Parameters<typeof eventBus.on>[0],
    (...args) => {
      windowManager.show('add-task')
      if (deliver) deliver('add-task', Events.MagnetFileSelection, args[0])
      else {
        const win = windowManager.get('add-task')
        if (win && !win.isDestroyed())
          win.webContents.send(Events.MagnetFileSelection, ...args)
      }
    }
  )
}
