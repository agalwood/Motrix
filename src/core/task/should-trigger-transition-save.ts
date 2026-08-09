import { TaskStatus } from '@shared/types/task'
import { isTerminalTaskStatus } from '@shared/types/task-actions'

/**
 * Status transitions that warrant an out-of-band session save.
 *
 * Two motivations:
 *
 * 1. **Capture-before-zeroing** — once aria2 (or the `aria2_motrix`
 *    fork) reports `paused` it tends to zero out `totalLength` /
 *    `completedLength` / file metadata on subsequent polls.
 *    `Downloading → Paused` saves the last good mirror values into
 *    `motrix.db` before the zeros land. The same applies to
 *    `Downloading → Error`, where `errorMessage` is most reliably
 *    captured at the moment of transition.
 *
 * 2. **Durability of identity-defining moments** — `Queued →
 *    Downloading` and `FetchingMetadata → Downloading` mark the
 *    point a task transitions from "submitted" to "actively running".
 *    Persisting at that boundary means a crash within the 15s
 *    auto-save window still preserves the task's runtime identity
 *    (gid, derived save path, file count) on restart.
 *
 * The polling loop calls this on every observed status change; pairs
 * not listed here fall back to the periodic auto-save tick.
 */
const TRANSITION_SAVE_PAIRS: ReadonlyArray<readonly [TaskStatus, TaskStatus]> =
  [
    [TaskStatus.Downloading, TaskStatus.Paused],
    [TaskStatus.Downloading, TaskStatus.Error],
    [TaskStatus.FetchingMetadata, TaskStatus.Error],
    [TaskStatus.Queued, TaskStatus.Downloading],
    [TaskStatus.FetchingMetadata, TaskStatus.Downloading],
  ]

export function shouldTriggerTransitionSave(
  before: TaskStatus,
  after: TaskStatus
): boolean {
  if (!isTerminalTaskStatus(before) && isTerminalTaskStatus(after)) return true

  for (const [from, to] of TRANSITION_SAVE_PAIRS) {
    if (before === from && after === to) return true
  }
  return false
}
