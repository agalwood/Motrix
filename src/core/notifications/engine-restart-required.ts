import { randomUUID } from 'node:crypto'
import type { EventBus } from '@core/events/event-bus'
import type { Logger } from '@core/logger'
import { Events } from '@shared/protocol/events'
import type { EngineRestartRequiredPayload } from '@shared/types/engine'
import { NotificationKinds } from '@shared/types/notification'
import type { NotificationCenter } from './notification-center'

export interface PublishEngineRestartRequiredDeps {
  eventBus: EventBus
  notificationCenter: Pick<NotificationCenter, 'notify'>
  log: Pick<Logger, 'warn'>
}

/**
 * Publish one durable notification-center row plus the transient renderer
 * event that owns the action-bearing toast. A notification write failure
 * must not turn an already-durable settings save into a failed command.
 */
export function publishEngineRestartRequired(
  deps: PublishEngineRestartRequiredDeps,
  changedKeys: readonly string[]
): void {
  const payload: EngineRestartRequiredPayload = {
    changedKeys: [...changedKeys],
  }

  try {
    deps.notificationCenter.notify({
      sourceKey: `engine-restart-required:${randomUUID()}`,
      kind: NotificationKinds.EngineRestartRequired,
      severity: 'warning',
      titleKey: 'notification.engineRestartRequired.title',
      bodyKey: 'notification.engineRestartRequired.body',
    })
  } catch (error) {
    deps.log.warn(
      { err: error, changedKeys: payload.changedKeys },
      'engine restart notification write failed'
    )
  }

  deps.eventBus.emit(Events.EngineRestartRequired, payload)
}
