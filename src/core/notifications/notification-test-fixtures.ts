import { DownloadErrorCode } from '@shared/errors'
import { TaskStatus } from '@shared/types/task'
import type {
  TaskDiagnosisOccurrence,
  TaskTerminalOccurrence,
} from '@shared/types/task-occurrence'
import { vi } from 'vitest'

/**
 * Shared test builders for `src/core/notifications/`, previously
 * copy-pasted (and already diverging in small ways) across
 * `occurrence-consumer.test.ts`, `e2e-must-reach.test.ts`,
 * `notification-center.test.ts`, and `engine-failure-subscriber.test.ts`. Every
 * caller overrides only the fields it asserts on; defaults below are the
 * "happy path" shape each builder's first caller relied on.
 */

export function makeLog() {
  return { warn: vi.fn(), error: vi.fn() }
}

export function makeTerminalOccurrence(
  overrides: Partial<TaskTerminalOccurrence> = {}
): TaskTerminalOccurrence {
  return {
    occurrenceId: 'occ-1',
    type: 'terminal',
    taskId: 'task-1',
    fromStatus: TaskStatus.Downloading,
    toStatus: TaskStatus.Error,
    cause: 'engine',
    errorGroup: {
      errorCode: DownloadErrorCode.NetworkError,
      errorMessage: 'connection reset',
      errorDetailKey: null,
      errorDetailParams: null,
    },
    createdAt: 1000,
    ...overrides,
  }
}

export function makeDiagnosisOccurrence(
  overrides: Partial<TaskDiagnosisOccurrence> = {}
): TaskDiagnosisOccurrence {
  return {
    occurrenceId: 'occ-diag-1',
    type: 'diagnosis',
    taskId: 'task-1',
    terminalOccurrenceId: 'occ-1',
    revision: 1,
    diagnosis: {
      errorCode: DownloadErrorCode.DiskFull,
      errorMessage: 'disk is full',
      errorDetailKey: null,
      errorDetailParams: null,
    },
    createdAt: 1000,
    ...overrides,
  }
}
