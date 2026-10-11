import type { EventBus } from '@core/events/event-bus'
import { subscribeForwardableEvents } from '@core/events/forward-events'
import { Events } from '@shared/protocol/events'
import { magnetFileSelectionSettledPayloadSchema } from '@shared/schemas/add-task'
import type { AppNotification } from '@shared/types/notification'
import type { RendererIntents } from '../window/renderer-intents'
import type { WindowManager } from '../window/window-manager'

export function setupEventForwarding(
  eventBus: EventBus,
  windowManager: WindowManager,
  getHiddenNotificationKinds: () => readonly string[] = () => [],
  intents?: Pick<RendererIntents, 'deliver' | 'settleMagnetSelection'>
): void {
  subscribeForwardableEvents(eventBus, (channel, args) => {
    if (channel === Events.MagnetFileSelectionSettled) {
      const settled = magnetFileSelectionSettledPayloadSchema.safeParse(args[0])
      if (settled.success) intents?.settleMagnetSelection(settled.data.taskId)
    }
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
      if (intents) intents.deliver('main', Events.NavigateTo, args[0])
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
      if (intents)
        intents.deliver(
          'add-task',
          Events.MagnetFileSelection,
          args[0],
          () => args[0]
        )
      else {
        const win = windowManager.get('add-task')
        if (win && !win.isDestroyed())
          win.webContents.send(Events.MagnetFileSelection, ...args)
      }
    }
  )
}
