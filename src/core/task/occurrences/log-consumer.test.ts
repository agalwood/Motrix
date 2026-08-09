import { DownloadErrorCode } from '@shared/errors'
import { TaskStatus } from '@shared/types/task'
import type {
  TaskDiagnosisOccurrence,
  TaskTerminalOccurrence,
} from '@shared/types/task-occurrence'
import { describe, expect, it, vi } from 'vitest'
import { createFailureLogConsumer } from './log-consumer'

function makeTerminalOccurrence(
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

function makeDiagnosisOccurrence(
  overrides: Partial<TaskDiagnosisOccurrence> = {}
): TaskDiagnosisOccurrence {
  return {
    occurrenceId: 'occ-diag-1',
    type: 'diagnosis',
    taskId: 'task-1',
    terminalOccurrenceId: 'occ-1',
    revision: 1,
    diagnosis: {
      errorCode: DownloadErrorCode.NetworkError,
      errorMessage: 'connection reset',
      errorDetailKey: null,
      errorDetailParams: null,
    },
    createdAt: 1000,
    ...overrides,
  }
}

function makeLog() {
  return { warn: vi.fn() }
}

describe('createFailureLogConsumer', () => {
  it('has the expected consumer name', () => {
    const consumer = createFailureLogConsumer(makeLog() as never)
    expect(consumer.name).toBe('failure-log')
  })

  it('logs one warning for a terminal Error occurrence', async () => {
    const log = makeLog()
    const { consume } = createFailureLogConsumer(log as never)
    const occ = makeTerminalOccurrence()

    await consume(occ)

    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      {
        taskId: 'task-1',
        occurrenceId: 'occ-1',
        errorCode: DownloadErrorCode.NetworkError,
        errorMessage: 'connection reset',
        cause: 'engine',
      },
      expect.any(String)
    )
  })

  it('is idempotent: re-dispatch of the same occurrence id logs nothing further', async () => {
    const log = makeLog()
    const { consume } = createFailureLogConsumer(log as never)
    const occ = makeTerminalOccurrence()

    await consume(occ)
    await consume(occ)
    await consume({ ...occ })

    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('logs a distinct occurrence id as its own warning', async () => {
    const log = makeLog()
    const { consume } = createFailureLogConsumer(log as never)

    await consume(makeTerminalOccurrence({ occurrenceId: 'occ-1' }))
    await consume(makeTerminalOccurrence({ occurrenceId: 'occ-2' }))

    expect(log.warn).toHaveBeenCalledTimes(2)
  })

  it('does not log a user-cancel terminal Error occurrence', async () => {
    const log = makeLog()
    const { consume } = createFailureLogConsumer(log as never)

    await consume(makeTerminalOccurrence({ cause: 'user-cancel' }))

    expect(log.warn).not.toHaveBeenCalled()
  })

  it('does not log a terminal Completed occurrence', async () => {
    const log = makeLog()
    const { consume } = createFailureLogConsumer(log as never)

    await consume(
      makeTerminalOccurrence({
        toStatus: TaskStatus.Completed,
        errorGroup: null,
      })
    )

    expect(log.warn).not.toHaveBeenCalled()
  })

  it('does not log a diagnosis occurrence', async () => {
    const log = makeLog()
    const { consume } = createFailureLogConsumer(log as never)

    await consume(makeDiagnosisOccurrence())

    expect(log.warn).not.toHaveBeenCalled()
  })
})
