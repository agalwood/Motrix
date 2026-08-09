import type { MotrixDatabase } from '@core/session/motrix-database'
import type { DownloadErrorCode } from '@shared/errors'
import type { TaskErrorFields } from '@shared/task-error/descriptor'
import type { DownloadTask } from '@shared/types/task'
import { isTerminalTaskStatus } from '@shared/types/task-actions'
import {
  diagnosisOccurrenceId,
  type TaskDiagnosisOccurrence,
  terminalOccurrenceId,
} from '@shared/types/task-occurrence'
import type { OccurrenceDispatcher } from './occurrences/occurrence-dispatcher'

export interface DiagnosisPatch {
  errorCode?: DownloadErrorCode | null
  errorMessage?: string | null
  errorDetailKey?: string | null
  errorDetailParams?: Record<string, string> | null
}

export type DiagnosisUpgradeResult =
  | { ok: true; revision: number; occurrence: TaskDiagnosisOccurrence | null }
  | { ok: false; reason: 'revision-conflict' | 'not-terminal' }

export interface ApplyDiagnosisUpgradeDeps {
  db: Pick<MotrixDatabase, 'applyDiagnosisUpgradeRow'>
  dispatcher: Pick<OccurrenceDispatcher, 'dispatch'>
}

/**
 * Merge a `DiagnosisPatch` onto the task's current error group.
 *
 * `errorCode`/`errorMessage` are independent: a provided value (including
 * explicit `null`) overwrites, `undefined` preserves. `errorDetailKey` and
 * `errorDetailParams` move as one pair keyed off whether a key was
 * provided — a caller relabeling the detail key without also passing
 * params gets `errorDetailParams: null` rather than silently keeping
 * whatever params the previous key carried.
 */
function applyPatch(
  current: TaskErrorFields,
  patch: DiagnosisPatch
): TaskErrorFields {
  const keyProvided = patch.errorDetailKey !== undefined
  const paramsProvided = patch.errorDetailParams !== undefined
  return {
    errorCode:
      patch.errorCode !== undefined ? patch.errorCode : current.errorCode,
    errorMessage:
      patch.errorMessage !== undefined
        ? patch.errorMessage
        : current.errorMessage,
    errorDetailKey: keyProvided
      ? (patch.errorDetailKey ?? null)
      : current.errorDetailKey,
    errorDetailParams: keyProvided
      ? paramsProvided
        ? (patch.errorDetailParams ?? null)
        : null
      : paramsProvided
        ? (patch.errorDetailParams ?? null)
        : current.errorDetailParams,
  }
}

/**
 * Apply a diagnosis-time upgrade to a terminal task's error group under
 * optimistic concurrency control.
 *
 * Rejects a non-terminal task outright — diagnosis only refines the error
 * group of a task that has already reached Completed/Error. Otherwise it
 * builds the effective patched group and hands the whole decision to
 * `applyDiagnosisUpgradeRow`, which compares revision and group against
 * the stored row inside one transaction:
 *
 * - stale `expectedRevision` (or the task is gone) → `revision-conflict`;
 * - stored group already identical → success with no write, no occurrence
 *   and no revision bump, so re-submitting the same diagnosis after a
 *   caller already observed success is safe to repeat;
 * - otherwise the row is updated, the paired diagnosis occurrence is
 *   inserted in the same transaction, the five in-memory fields on `task`
 *   are refreshed, and the occurrence is dispatched.
 *
 * The identity check deliberately lives on the storage side. Comparing the
 * patch against the caller's own snapshot instead would let a stale caller
 * — one whose task object predates another writer's upgrade — observe a
 * false "already applied" success.
 *
 * Note that the patch is still merged onto the caller's snapshot, so a
 * partial patch (one that leaves `errorCode` or `errorMessage` undefined)
 * inherits those fields from the caller's view of the task, not from the
 * row.
 */
export async function applyDiagnosisUpgrade(
  deps: ApplyDiagnosisUpgradeDeps,
  task: DownloadTask,
  patch: DiagnosisPatch,
  expectedRevision: number
): Promise<DiagnosisUpgradeResult> {
  if (!isTerminalTaskStatus(task.status)) {
    return { ok: false, reason: 'not-terminal' }
  }

  const current: TaskErrorFields = {
    errorCode: task.errorCode,
    errorMessage: task.errorMessage,
    errorDetailKey: task.errorDetailKey,
    errorDetailParams: task.errorDetailParams,
  }
  const next = applyPatch(current, patch)
  const nextRevision = expectedRevision + 1
  const finishedAt = task.finishedAt ?? Date.now()
  const occurrence: TaskDiagnosisOccurrence = {
    occurrenceId: diagnosisOccurrenceId(task.id, finishedAt, nextRevision),
    type: 'diagnosis',
    taskId: task.id,
    terminalOccurrenceId: terminalOccurrenceId(
      task.id,
      task.status,
      finishedAt
    ),
    revision: nextRevision,
    diagnosis: next,
    createdAt: Date.now(),
  }

  const outcome = deps.db.applyDiagnosisUpgradeRow({
    motrixId: task.id,
    expectedRevision,
    nextRevision,
    errorCode: next.errorCode,
    errorMessage: next.errorMessage,
    errorDetailKey: next.errorDetailKey,
    errorDetailParams: next.errorDetailParams,
    occurrence,
  })

  if (outcome === 'conflict') {
    return { ok: false, reason: 'revision-conflict' }
  }
  if (outcome === 'unchanged') {
    return { ok: true, revision: expectedRevision, occurrence: null }
  }

  task.errorCode = next.errorCode
  task.errorMessage = next.errorMessage
  task.errorDetailKey = next.errorDetailKey
  task.errorDetailParams = next.errorDetailParams
  task.diagnosisRevision = nextRevision

  await deps.dispatcher.dispatch(occurrence)

  return { ok: true, revision: nextRevision, occurrence }
}
