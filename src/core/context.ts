import type { EventBus } from './events/event-bus'

export interface CoreContext {
  eventBus: EventBus
}
