import { TaskStatus, TaskType } from '@shared/types/task'

/**
 * Decide whether a task that just reached a terminal state should be
 * evicted from the engine's persistent state (aria2's `download_history`
 * + session task row).
 *
 * Two transitions qualify:
 *
 * - **Seeding → Completed (BT/Magnet)** — the share-ratio / seed-time
 *   target was met. Leaving the row in aria2.db causes a
 *   "Completed → Seeding → Completed" flicker on the next launch —
 *   aria2 reloads it, runs through one more terminating-seed cycle,
 *   then stops.
 * - **any → Error (all types)** — Error is durable user-visible history,
 *   never a retryable engine state. With `--force-save=true` (an L1
 *   product invariant) an errored, non-user-removed download keeps its
 *   session task row, and the aria2_motrix sqlite store restores every
 *   row unfiltered at startup — resurrecting and auto-retrying the
 *   doomed download. Evicting here is in-session hygiene that keeps the
 *   engine's session store clean while running; the boot-time guard
 *   against the resurrection (and its duplicate notification per boot)
 *   is the Error shield in `SessionManager.restore` Pass 1, and Pass 2
 *   keeps the Error row visible from motrix.db alone.
 *
 * In both cases motrix.db is the durable record-of-truth after the
 * transition; a user-initiated retry re-adds through the reAdd path,
 * which purges any stale engine row itself.
 *
 * Pure decision function — no I/O, no side effects. The caller is
 * responsible for invoking `adapter.removeDownloadResult(gid)` and
 * handling the resulting promise (the call is idempotent at the adapter
 * layer, so fire-and-forget is acceptable).
 */
export function shouldEvictFromEngine(
  before: TaskStatus,
  after: TaskStatus,
  type: TaskType
): boolean {
  if (after === TaskStatus.Error) return before !== TaskStatus.Error
  if (type !== TaskType.Bt && type !== TaskType.Magnet) return false
  return before === TaskStatus.Seeding && after === TaskStatus.Completed
}
