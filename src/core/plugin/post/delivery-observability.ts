import type { Logger } from '@core/logger'
import type {
  PostDeliveryAdmissionReason,
  PostDeliveryPermanentReason,
  PostHookName,
} from './delivery-types'

interface DeliveryEventBase {
  at: number
  pluginId?: string
  hook?: PostHookName
  deliveryId?: string
}

export type PostDeliveryEvent =
  | (DeliveryEventBase & {
      type: 'plugin.post.recovery_finished'
      reclaimedDeliveries: number
      reclaimedBreakerProbes: number
    })
  | (DeliveryEventBase & {
      type: 'plugin.post.claimed'
      pluginId: string
      hook: PostHookName
      deliveryId: string
      attemptCount: number
      queueLatencyMs: number
    })
  | (DeliveryEventBase & {
      type: 'plugin.post.invocation_finished'
      pluginId: string
      hook: PostHookName
      deliveryId: string
      invocationId: string
      durationMs: number
      outcome: 'delivered' | 'retry' | 'dead_letter'
      errorCode?: string
    })
  | (DeliveryEventBase & {
      type: 'plugin.post.breaker_changed'
      pluginId: string
      state: 'closed' | 'open' | 'half_open'
      openUntil?: number
    })
  | (DeliveryEventBase & {
      type: 'plugin.post.admission_rejected'
      pluginId: string
      hook: PostHookName
      reason: PostDeliveryAdmissionReason
      occurrenceId: string
    })
  | (DeliveryEventBase & {
      type: 'plugin.post.lifecycle_terminal'
      pluginId: string
      affectedRows: number
      reason: PostDeliveryPermanentReason
    })
  | (DeliveryEventBase & {
      type: 'plugin.post.storage_error'
      operation: string
      errorCode: 'plugin.post.storage_error'
    })

export interface PostDeliveryObservability {
  emit(event: PostDeliveryEvent): void | Promise<void>
}

export const NOOP_POST_DELIVERY_OBSERVABILITY: PostDeliveryObservability = {
  emit: () => {},
}

/** Production adapter shared by both shells. Event payloads are deliberately
 * limited to durable identities, counters, and stable error codes. */
export function createLoggingPostDeliveryObservability(
  logger: Pick<Logger, 'info' | 'warn'>
): PostDeliveryObservability {
  return {
    emit: (event) => {
      const details = { postDelivery: event }
      if (
        event.type === 'plugin.post.storage_error' ||
        event.type === 'plugin.post.admission_rejected'
      ) {
        logger.warn(details, event.type)
        return
      }
      logger.info(details, event.type)
    },
  }
}

export function safeObserve(
  observability: PostDeliveryObservability,
  event: PostDeliveryEvent
): void {
  try {
    const result = observability.emit(event)
    if (result && typeof result.catch === 'function')
      void result.catch(() => {})
  } catch {
    // Telemetry cannot affect durable delivery state.
  }
}
