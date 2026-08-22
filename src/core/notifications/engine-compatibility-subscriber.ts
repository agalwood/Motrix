import type { EventBus } from '@core/events/event-bus'
import type { Logger } from '@core/logger'
import { Events } from '@shared/protocol/events'
import type { EngineCompatibilityWarningPayload } from '@shared/types/engine'
import { NotificationKinds } from '@shared/types/notification'
import type { NotificationCenter } from './notification-center'

export interface EngineCompatibilitySubscriberDeps {
  eventBus: EventBus
  notificationCenter: Pick<NotificationCenter, 'notify'>
  log: Pick<Logger, 'warn'>
}

/**
 * Persist the pre-spawn shell probe result as a warning. The version-scoped
 * source key makes repeated starts with the same replacement binary
 * idempotent while allowing a newly detected version to surface again.
 */
export function registerEngineCompatibilitySubscriber(
  deps: EngineCompatibilitySubscriberDeps
): void {
  deps.eventBus.on(Events.EngineCompatibilityWarning, (...args: unknown[]) => {
    const payload = args[0] as EngineCompatibilityWarningPayload
    try {
      deps.notificationCenter.notify({
        sourceKey: `engine-compatibility:${payload.version}`,
        kind: NotificationKinds.EngineCompatibility,
        severity: 'warning',
        titleKey: 'notification.engineCompatibility.title',
        bodyKey: 'notification.engineCompatibility.body',
        bodyParams: {
          version: payload.version,
          limit: String(payload.connectionLimit),
        },
      })
    } catch (error) {
      deps.log.warn(
        { err: error, version: payload.version },
        'engineCompatibilitySubscriber: notify() threw'
      )
    }
  })
}
