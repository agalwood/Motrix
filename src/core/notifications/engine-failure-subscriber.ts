import type { EventBus } from '@core/events/event-bus'
import type { Logger } from '@core/logger'
import type { MotrixDatabase } from '@core/session/motrix-database'
import { Events } from '@shared/protocol/events'
import type { EngineFailurePayload } from '@shared/types/engine'
import {
  EngineFailureReason,
  EngineState,
  engineFailureReasonKey,
} from '@shared/types/engine'
import { NotificationKinds } from '@shared/types/notification'
import type { NotificationCenter } from './notification-center'

export interface EngineFailureSubscriberDeps {
  motrixDb: MotrixDatabase
  eventBus: EventBus
  notificationCenter: Pick<NotificationCenter, 'notify'>
  now?: () => number
  log: Pick<Logger, 'warn'>
}

const AUTO_RECOVERABLE_REASONS = new Set<EngineFailureReason>([
  EngineFailureReason.UnexpectedExit,
  EngineFailureReason.HealthCheckFailed,
])

/**
 * Startup wiring for engine-incident notifications (Task 13):
 *
 * 1. Grace-clean stale engine-scoped ledger rows (`task_id IS NULL`) — an
 *    `EngineFailurePayload.incidentId` is only unique within the boot that
 *    produced it (the per-instance `seq` resets on restart), so there is no
 *    replay source for these rows across a boot and they must be cleared
 *    before subscribing, not after.
 * 2. Subscribe to `Events.EngineFailureOccurred` and turn terminal payloads
 *    into notification-center rows. Unexpected exits and health-check misses
 *    are held while the supervisor performs its automatic recovery: reaching
 *    Ready discards the transient incident, while reaching Failed publishes
 *    it. This prevents a recovered login-start race from leaving a durable
 *    "engine failed" notification next to a Ready status.
 * 3. Delivery idempotency for any payload
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

  let pendingRecoverableFailure: EngineFailurePayload | null = null

  const notify = (payload: EngineFailurePayload) => {
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
  }

  deps.eventBus.on(Events.EngineFailureOccurred, (...args: unknown[]) => {
    const payload = args[0] as EngineFailurePayload
    if (AUTO_RECOVERABLE_REASONS.has(payload.reason)) {
      pendingRecoverableFailure = payload
      return
    }

    // A concrete startup/restart failure supersedes the earlier transient
    // exit that led into this recovery attempt; report only the terminal
    // cause instead of creating two rows for one incident.
    pendingRecoverableFailure = null
    notify(payload)
  })

  deps.eventBus.on(Events.EngineStateChanged, (...args: unknown[]) => {
    const state = args[0] as EngineState
    if (state === EngineState.Ready) {
      pendingRecoverableFailure = null
      return
    }
    if (state === EngineState.Failed && pendingRecoverableFailure) {
      const payload = pendingRecoverableFailure
      pendingRecoverableFailure = null
      notify(payload)
    }
  })
}
