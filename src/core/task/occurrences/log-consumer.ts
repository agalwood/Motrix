import type { Logger } from '@core/logger'
import { TaskStatus } from '@shared/types/task'
import type { TaskOccurrence } from '@shared/types/task-occurrence'
import type { OccurrenceConsumer } from './occurrence-dispatcher'

/**
 * Warns once per qualifying terminal occurrence — a task that ended in
 * Error for a reason other than the user cancelling it. Diagnosis
 * occurrences and Completed/user-cancel terminals are silently ignored;
 * only Error carries operational signal worth a log line.
 *
 * The in-memory `Set<occurrenceId>` provides idempotency only within this
 * process — it absorbs a drain re-dispatch of an already-logged occurrence
 * that happens before this consumer is torn down. It does not survive a
 * restart (the Set is recreated empty), so redelivery across a crash/restart
 * is not deduplicated here; that is left to each consumer's own idempotency
 * contract (e.g. the notification ledger, the timeline's revision-keyed
 * items), where a duplicate would actually be user-visible.
 */
export function createFailureLogConsumer(log: Logger): {
  name: 'failure-log'
  consume: OccurrenceConsumer
} {
  const logged = new Set<string>()

  const consume: OccurrenceConsumer = (occ: TaskOccurrence): void => {
    if (occ.type !== 'terminal') return
    if (occ.toStatus !== TaskStatus.Error) return
    if (occ.cause === 'user-cancel') return
    if (logged.has(occ.occurrenceId)) return
    logged.add(occ.occurrenceId)
    log.warn(
      {
        taskId: occ.taskId,
        occurrenceId: occ.occurrenceId,
        errorCode: occ.errorGroup?.errorCode ?? null,
        errorMessage: occ.errorGroup?.errorMessage ?? null,
        cause: occ.cause,
      },
      'task failed'
    )
  }

  return { name: 'failure-log', consume }
}
