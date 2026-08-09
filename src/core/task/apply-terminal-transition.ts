import type { TaskRow } from '@core/session/motrix-database'
import type { DownloadErrorCode } from '@shared/errors'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { isTerminalTaskStatus } from '@shared/types/task-actions'

export type TerminalFields = Pick<
  DownloadTask,
  | 'status'
  | 'finishedAt'
  | 'errorMessage'
  | 'errorCode'
  | 'errorDetailKey'
  | 'errorDetailParams'
  | 'diagnosisRevision'
>

type TerminalFieldsRow = Pick<
  TaskRow,
  | 'aggStatus'
  | 'finishedAt'
  | 'errorMessage'
  | 'errorCode'
  | 'errorDetailKey'
  | 'errorDetailParams'
  | 'diagnosisRevision'
>

/**
 * Build the `current` snapshot `applyTerminalTransition` expects, from a
 * persisted `TaskRow` (mapping its `aggStatus` field to `status`), or the
 * brand-new-task defaults when there is no row yet (e.g. an adopted aria2
 * orphan with no matching database record). Centralizes the 7-field
 * hand-copy that used to be repeated at every call site so the next field
 * addition to the terminal-metadata invariant edits one place instead of
 * six.
 */
export function terminalFieldsFromRow(
  row: TerminalFieldsRow | null
): TerminalFields {
  if (!row) {
    return {
      status: TaskStatus.Queued,
      finishedAt: null,
      errorMessage: null,
      errorCode: null,
      errorDetailKey: null,
      errorDetailParams: null,
      diagnosisRevision: 0,
    }
  }
  return {
    status: row.aggStatus,
    finishedAt: row.finishedAt,
    errorMessage: row.errorMessage,
    errorCode: row.errorCode,
    errorDetailKey: row.errorDetailKey,
    errorDetailParams: row.errorDetailParams,
    diagnosisRevision: row.diagnosisRevision,
  }
}

export interface TerminalTransitionInput {
  finishedAt?: number | null
  errorMessage?: string | null
  errorCode?: DownloadErrorCode | null
  errorDetailKey?: string | null
  errorDetailParams?: Record<string, string> | null
  diagnosisRevision?: number
}

function validFinishedAt(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Apply the canonical terminal-metadata invariant without mutating `current`.
 *
 * Callers spread or assign the returned fields onto their aggregate. The
 * explicit `now` argument keeps transition tests deterministic.
 */
export function applyTerminalTransition(
  current: TerminalFields,
  nextStatus: TaskStatus,
  incoming: TerminalTransitionInput = {},
  now = Date.now()
): TerminalFields {
  if (!isTerminalTaskStatus(nextStatus)) {
    return {
      status: nextStatus,
      finishedAt: null,
      errorMessage: null,
      errorCode: null,
      errorDetailKey: null,
      errorDetailParams: null,
      diagnosisRevision: 0,
    }
  }

  // Same-status re-commit of an already-terminal task: keep the existing
  // terminal metadata untouched. Fields stay enumerated explicitly — callers
  // pass whole DownloadTasks, so a `...current` spread would leak every
  // non-terminal field into the returned TerminalFields.
  if (current.status === nextStatus) {
    return {
      status: nextStatus,
      finishedAt: current.finishedAt,
      errorMessage: current.errorMessage,
      errorCode: current.errorCode,
      errorDetailKey: current.errorDetailKey,
      errorDetailParams: current.errorDetailParams,
      diagnosisRevision: current.diagnosisRevision,
    }
  }

  const isCompleting = nextStatus === TaskStatus.Completed
  // One rule per error-metadata field: completing clears to the field's
  // cleared value; erroring takes the incoming value when provided (null is
  // a deliberate value, undefined means "not provided") else keeps current.
  const resolve = <T>(incoming: T | undefined, current: T, cleared: T): T =>
    isCompleting
      ? (incoming ?? cleared)
      : incoming !== undefined
        ? incoming
        : current

  return {
    status: nextStatus,
    finishedAt: validFinishedAt(incoming.finishedAt)
      ? incoming.finishedAt
      : now,
    errorMessage: resolve(incoming.errorMessage, current.errorMessage, null),
    errorCode: resolve(incoming.errorCode, current.errorCode, null),
    errorDetailKey: resolve(
      incoming.errorDetailKey,
      current.errorDetailKey,
      null
    ),
    errorDetailParams: resolve(
      incoming.errorDetailParams,
      current.errorDetailParams,
      null
    ),
    diagnosisRevision: resolve(
      incoming.diagnosisRevision,
      current.diagnosisRevision,
      0
    ),
  }
}
