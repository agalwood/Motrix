import { ForwardableEvents } from '@shared/protocol/forwardable-events'
import type { EventBus } from './event-bus'

export type ForwardableChannel = (typeof ForwardableEvents)[number]

export function subscribeForwardableEvents(
  bus: EventBus,
  handler: (channel: ForwardableChannel, args: unknown[]) => void
): void {
  for (const channel of ForwardableEvents) {
    bus.on(channel as Parameters<typeof bus.on>[0], (...args) => {
      handler(channel, args)
    })
  }
}
