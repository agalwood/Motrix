import type { Logger } from '@core/logger'
import type { MotrixDatabase } from '@core/session/motrix-database'
import type { EventChannel } from '@shared/protocol/events'
import { Events } from '@shared/protocol/events'
import { resolveFailureDescriptor } from '@shared/task-error/descriptor'
import type {
  AppNotification,
  NotificationSeverity,
} from '@shared/types/notification'
import type { TaskDiagnosisOccurrence } from '@shared/types/task-occurrence'

export interface NotifyInput {
  sourceKey: string
  kind: string
  severity: NotificationSeverity
  titleKey: string
  titleParams?: Record<string, string>
  bodyKey?: string
  bodyParams?: Record<string, string>
  taskId?: string
  createdAt?: number
}

export interface NotificationCenterDeps {
  // Structural subset is fine — the concrete MotrixDatabase type is used so
  // tests can pass a real in-memory instance without a hand-rolled mock.
  store: MotrixDatabase
  // Both shells pass `eventBus.emit.bind(eventBus)`. Must not throw — both
  // shells pass `EventBus.emit`, which isolates listeners (see
  // `EventBusOptions.onListenerError`).
  emit: (channel: EventChannel, payload?: unknown) => void
  now?: () => number
  log: Pick<Logger, 'warn' | 'error'>
}

/**
 * Domain logic for the notification center: store-transactional writes
 * (Task 10's `MotrixDatabase` methods) plus best-effort event fan-out.
 *
 * The store write always happens first and is the source of truth for
 * whether anything changed; events are a secondary side effect. Emits go
 * straight to `deps.emit` — the `EventBus` is the single isolation choke
 * point, so a throwing subscriber on one channel can neither unwind the
 * mutating call nor suppress a second, independent emit (see `notify()`,
 * which fires two channels back to back).
 */
export class NotificationCenter {
  private readonly now: () => number

  constructor(private readonly deps: NotificationCenterDeps) {
    this.now = deps.now ?? Date.now
  }

  /**
   * Insert a notification through the ledger-guarded store write. A `null`
   * result means `sourceKey` was already delivered (or superseded) — no
   * display row is created and no event is emitted. A fresh row emits
   * `NotificationAdded(row)` then `NotificationsChanged`; the bus isolates
   * each listener, so a throwing subscriber on the first channel cannot
   * suppress the second.
   */
  notify(input: NotifyInput): { fresh: boolean } {
    const row = this.deps.store.insertNotificationWithLedger({
      sourceKey: input.sourceKey,
      taskId: input.taskId ?? null,
      kind: input.kind,
      severity: input.severity,
      titleKey: input.titleKey,
      titleParams: input.titleParams ?? null,
      bodyKey: input.bodyKey ?? null,
      bodyParams: input.bodyParams ?? null,
      createdAt: input.createdAt ?? this.now(),
    })
    if (row === null) return { fresh: false }

    this.deps.emit(Events.NotificationAdded, row)
    this.deps.emit(Events.NotificationsChanged)
    return { fresh: true }
  }

  /**
   * Refine an already-terminal notification's body once a later diagnosis
   * occurrence resolves a more specific reason. Matches the display row by
   * `terminalOccurrenceId` (the `sourceKey` a terminal notify() used) and
   * patches it to the diagnosis descriptor's best (first) reason candidate.
   * Never inserts a row and never emits `NotificationAdded` — this only
   * ever refines an existing row's body.
   */
  applyDiagnosisUpgrade(occ: TaskDiagnosisOccurrence): boolean {
    const descriptor = resolveFailureDescriptor(occ.diagnosis)
    const [candidate] = descriptor.reasonCandidates
    const changed = this.deps.store.updateNotificationBySourceKey(
      occ.terminalOccurrenceId,
      { bodyKey: candidate.key, bodyParams: candidate.params ?? null }
    )
    if (changed) this.deps.emit(Events.NotificationsChanged)
    return changed
  }

  markRead(id: string): boolean {
    const changed = this.deps.store.markNotificationRead(id, this.now())
    if (changed) this.deps.emit(Events.NotificationsChanged)
    return changed
  }

  markAllRead(): number {
    const count = this.deps.store.markAllNotificationsRead(this.now())
    if (count > 0) this.deps.emit(Events.NotificationsChanged)
    return count
  }

  delete(id: string): boolean {
    const changed = this.deps.store.deleteNotification(id)
    if (changed) this.deps.emit(Events.NotificationsChanged)
    return changed
  }

  clear(): number {
    const count = this.deps.store.clearNotifications()
    if (count > 0) this.deps.emit(Events.NotificationsChanged)
    return count
  }

  list(limit?: number): AppNotification[] {
    return limit === undefined
      ? this.deps.store.listNotifications()
      : this.deps.store.listNotifications(limit)
  }

  unreadCount(): number {
    return this.deps.store.getUnreadNotificationCount()
  }
}
