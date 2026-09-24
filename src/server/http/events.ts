import type { EventBus } from '@core/events/event-bus'
import { subscribeForwardableEvents } from '@core/events/forward-events'
import { getLogger } from '@core/logger'

const log = getLogger('web-events')

interface SocketLike {
  send(data: string, callback?: (error?: Error) => void): void
  terminate?(): void
}

export function bindEventBroadcaster(bus: EventBus) {
  const sockets = new Map<SocketLike, () => boolean>()

  subscribeForwardableEvents(bus, (channel, args) => {
    broadcast(channel, args)
  })

  function broadcast(channel: string, args: unknown[]): void {
    if (sockets.size === 0) return
    const frame = JSON.stringify({ channel, args })
    for (const [s, eligible] of sockets) {
      if (!eligible()) {
        sockets.delete(s)
        continue
      }
      const failed = (error: unknown) => {
        if (!sockets.delete(s)) return
        log.warn({ err: error }, 'event delivery failed; closing socket')
        s.terminate?.()
      }
      try {
        s.send(frame, (error) => {
          if (error) failed(error)
        })
      } catch (error) {
        failed(error)
      }
    }
  }

  return {
    broadcast,
    register: (s: SocketLike, eligible: () => boolean = () => true) =>
      sockets.set(s, eligible),
    unregister: (s: SocketLike) => sockets.delete(s),
    count: () => sockets.size,
  }
}
