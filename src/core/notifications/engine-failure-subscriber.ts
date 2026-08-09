import type { EventBus } from '@core/events/event-bus'
import type { Logger } from '@core/logger'
import type { MotrixDatabase } from '@core/session/motrix-database'
import { Events } from '@shared/protocol/events'
import type { EngineFailurePayload } from '@shared/types/engine'
import { engineFailureReasonKey } from '@shared/types/engine'
import { NotificationKinds } from '@shared/types/notification'
import type { NotificationCenter } from './notification-center'

export interface EngineFailureSubscriberDeps {
  motrixDb: MotrixDatabase
  eventBus: EventBus
  notificationCenter: Pick<NotificationCenter, 'notify'>
  now?: () => number
  log: Pick<Logger, 'warn'>
}

/**
 * Startup wiring for engine-incident notifications (Task 13):
 *
 * 1. Grace-clean stale engine-scoped ledger rows (`task_id IS NULL`) — an
 *    `EngineFailurePayload.incidentId` is only unique within the boot that
 *    produced it (the per-instance `seq` resets on restart), so there is no
 *    replay source for these rows across a boot and they must be cleared
 *    before subscribing, not after.
 * 2. Subscribe to `Events.EngineFailureOccurred` and turn each payload into
 *    a notification-center row. Delivery idempotency for any payload
 *    re-emitted within the same boot is the ledger's job (`sourceKey =
 *    incidentId` inside `NotificationCenter.notify`) — this subscriber
 *    holds no dedup state of its own.
 *
 * Call once per boot, in this order, from both shells' bootstrap.
 */
export function registerEngineFailureSubscriber(
  deps: EngineFailureSubscriberDeps
): void {
  const now = deps.now ?? Date.now
  deps.motrixDb.deleteEngineNotificationLedgerBefore(now())

  deps.eventBus.on(Events.EngineFailureOccurred, (...args: unknown[]) => {
    const payload = args[0] as EngineFailurePayload
    // notify()'s store write (insertNotificationWithLedger) can throw
    // (e.g. SQLITE_FULL). This listener runs synchronously inside
    // EventBus.emit, which has no per-listener isolation, and that emit
    // is called from EngineSupervisor.recordFailure() — itself invoked
    // from doStart()'s catch block and restartWithBackoff(). An
    // uncaught throw here would unwind through recordFailure() and
    // abort the caller's own state transition (e.g. never reaching
    // setState(Failed)), so this side effect must never propagate.
    try {
      deps.notificationCenter.notify({
        sourceKey: payload.incidentId,
        kind: NotificationKinds.EngineFailure,
        severity: 'error',
        titleKey: 'notification.engineFailure.title',
        bodyKey: engineFailureReasonKey(payload.reason),
        createdAt: payload.occurredAt,
      })
    } catch (err) {
      deps.log.warn(
        { err, incidentId: payload.incidentId },
        'engineFailureSubscriber: notify() threw'
      )
    }
  })
}
