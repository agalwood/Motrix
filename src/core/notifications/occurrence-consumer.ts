import type { OccurrenceConsumer } from '@core/task/occurrences/occurrence-dispatcher'
import { resolveFailureDescriptor } from '@shared/task-error/descriptor'
import { NotificationKinds } from '@shared/types/notification'
import { TaskStatus } from '@shared/types/task'
import type { NotificationCenter } from './notification-center'

/**
 * Turns durably-dispatched task occurrences into notification-center rows.
 * A user-initiated cancel never notifies (spec §6); everything else maps
 * 1:1 onto a `notify()` (terminal) or `applyDiagnosisUpgrade()` (diagnosis)
 * call. Idempotency across replay/redelivery is the ledger's job
 * (`sourceKey = occurrenceId` inside `NotificationCenter.notify`) — this
 * consumer holds no in-process dedup state of its own. A diagnosis that
 * matches no existing row (its terminal occurrence hasn't been dispatched
 * yet) throws instead of silently acking, so the dispatcher redelivers it
 * on the next drain once the terminal row exists.
 */
export function createNotificationOccurrenceConsumer(deps: {
  center: NotificationCenter
  getTaskName: (taskId: string) => string | null
}): { name: 'notification-center'; consume: OccurrenceConsumer } {
  const consume: OccurrenceConsumer = (occ): void => {
    if (occ.type === 'diagnosis') {
      // A diagnosis whose terminal row hasn't landed yet (recovery MarkError
      // on a task already Error from a prior boot whose terminal occurrence
      // never dispatched) matches zero rows here — applyDiagnosisUpgrade
      // returns false. Throwing leaves this occurrence undispatched (see
      // OccurrenceDispatcher's error path) so the NEXT drain — which runs
      // after the terminal row has since been inserted — re-applies it
      // instead of the upgrade silently acking as a no-op.
      if (!deps.center.applyDiagnosisUpgrade(occ)) {
        throw new Error(
          `notification-center: diagnosis ${occ.occurrenceId} matched no terminal row for terminalOccurrenceId ${occ.terminalOccurrenceId}; leaving undispatched for redelivery`
        )
      }
      return
    }

    // User cancellations never notify, regardless of the resulting status.
    if (occ.cause === 'user-cancel') return

    const name = deps.getTaskName(occ.taskId) ?? occ.taskId

    if (occ.toStatus === TaskStatus.Completed) {
      deps.center.notify({
        sourceKey: occ.occurrenceId,
        kind: NotificationKinds.TaskComplete,
        severity: 'info',
        titleKey: 'notification.taskComplete.title',
        titleParams: { name },
        taskId: occ.taskId,
        createdAt: occ.createdAt,
      })
      return
    }

    // toStatus === TaskStatus.Error
    const descriptor = resolveFailureDescriptor(
      occ.errorGroup ?? {
        errorCode: null,
        errorMessage: null,
        errorDetailKey: null,
        errorDetailParams: null,
      }
    )
    const [first] = descriptor.reasonCandidates
    deps.center.notify({
      sourceKey: occ.occurrenceId,
      kind: NotificationKinds.TaskError,
      severity: 'error',
      titleKey: 'notification.taskError.title',
      titleParams: { name },
      bodyKey: first.key,
      bodyParams: first.params ?? undefined,
      taskId: occ.taskId,
      createdAt: occ.createdAt,
    })
  }

  return { name: 'notification-center', consume }
}
