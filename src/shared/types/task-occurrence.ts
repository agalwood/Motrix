import type { TaskErrorFields } from '../task-error/descriptor'
import type { TaskStatus } from './task'

export type OccurrenceCause =
  | 'engine'
  | 'finalize'
  | 'media'
  | 'recovery'
  | 'user-cancel'

export interface TaskTerminalOccurrence {
  occurrenceId: string
  type: 'terminal'
  taskId: string
  fromStatus: TaskStatus
  toStatus: TaskStatus.Completed | TaskStatus.Error
  cause: OccurrenceCause
  errorGroup: TaskErrorFields | null
  createdAt: number
}

export interface TaskDiagnosisOccurrence {
  occurrenceId: string
  type: 'diagnosis'
  taskId: string
  terminalOccurrenceId: string
  revision: number
  diagnosis: TaskErrorFields
  createdAt: number
}

export type TaskOccurrence = TaskTerminalOccurrence | TaskDiagnosisOccurrence

export function terminalOccurrenceId(
  taskId: string,
  to: TaskStatus,
  finishedAt: number
): string {
  return `${taskId}:${to}:${finishedAt}`
}

export function diagnosisOccurrenceId(
  taskId: string,
  finishedAt: number,
  revision: number
): string {
  return `${taskId}:${finishedAt}:diag:${revision}`
}
