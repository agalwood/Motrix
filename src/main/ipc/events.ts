import type { EventBus } from '@core/events/event-bus'
import { subscribeForwardableEvents } from '@core/events/forward-events'
import { Events } from '@shared/protocol/events'
import type { WindowManager } from '../window/window-manager'

function sendToAddTaskWhenReady(
  windowManager: WindowManager,
  channel: string,
  args: unknown[]
): void {
  windowManager.show('add-task')
  const win = windowManager.get('add-task')
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
  windowManager: WindowManager
): void {
  subscribeForwardableEvents(eventBus, (channel, args) => {
    windowManager.broadcast(channel, ...args)
  })

  // Navigation — only the main window has a React Router,
  // so forward directly instead of broadcasting.
  eventBus.on(
    Events.NavigateTo as Parameters<typeof eventBus.on>[0],
    (...args) => {
      const win = windowManager.get('main')
      if (win && !win.isDestroyed()) {
        win.webContents.send(Events.NavigateTo, ...args)
      }
    }
  )

  // Torrent — MagnetFileSelection opens AddTaskWindow with file selection
  eventBus.on(
    Events.MagnetFileSelection as Parameters<typeof eventBus.on>[0],
    (...args) => {
      sendToAddTaskWhenReady(windowManager, Events.MagnetFileSelection, args)
    }
  )
}
