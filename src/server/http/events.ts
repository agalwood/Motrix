import type { EventBus } from '@core/events/event-bus'
import { subscribeForwardableEvents } from '@core/events/forward-events'

interface SocketLike {
  send(data: string): void
}

export function bindEventBroadcaster(bus: EventBus) {
  const sockets = new Set<SocketLike>()

  subscribeForwardableEvents(bus, (channel, args) => {
    if (sockets.size === 0) return
    const frame = JSON.stringify({ channel, args })
    for (const s of sockets) {
      try {
        s.send(frame)
      } catch {
        // Drop broken sockets silently; ws close handler unregisters.
      }
    }
  })

  return {
    register: (s: SocketLike) => sockets.add(s),
    unregister: (s: SocketLike) => sockets.delete(s),
    count: () => sockets.size,
  }
}
