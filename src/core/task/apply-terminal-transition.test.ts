import { DownloadErrorCode } from '@shared/errors'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { describe, expect, it } from 'vitest'
import { applyTerminalTransition } from './apply-terminal-transition'

type TerminalFields = Pick<
  DownloadTask,
  | 'status'
  | 'finishedAt'
  | 'errorMessage'
  | 'errorCode'
  | 'errorDetailKey'
  | 'errorDetailParams'
  | 'diagnosisRevision'
>

function fields(overrides: Partial<TerminalFields> = {}): TerminalFields {
  return {
    status: TaskStatus.Downloading,
    finishedAt: null,
    errorMessage: null,
    errorCode: null,
    errorDetailKey: null,
    errorDetailParams: null,
    diagnosisRevision: 0,
    ...overrides,
  }
}

describe('applyTerminalTransition', () => {
  it.each([TaskStatus.Completed, TaskStatus.Error])(
    'uses a valid incoming time for a new %s outcome',
    (status) => {
      expect(
        applyTerminalTransition(fields(), status, { finishedAt: 1234 }, 9999)
          .finishedAt
      ).toBe(1234)
    }
  )

  it.each([null, 0, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'uses now when a new terminal outcome receives invalid time %s',
    (finishedAt) => {
      expect(
        applyTerminalTransition(
          fields(),
          TaskStatus.Completed,
          { finishedAt },
          9999
        ).finishedAt
      ).toBe(9999)
    }
  )

  it.each([TaskStatus.Completed, TaskStatus.Error])(
    'preserves same-state %s terminal metadata',
    (status) => {
      const current = fields({
        status,
        finishedAt: 1234,
        errorMessage: 'original',
        errorCode: DownloadErrorCode.Timeout,
      })
      expect(
        applyTerminalTransition(
          current,
          status,
          {
            finishedAt: 5678,
            errorMessage: 'replacement',
            errorCode: DownloadErrorCode.Unknown,
          },
          9999
        )
      ).toEqual(current)
    }
  )

  it('establishes a new time and details when the terminal outcome changes', () => {
    expect(
      applyTerminalTransition(
        fields({
          status: TaskStatus.Completed,
          finishedAt: 1234,
          errorMessage: null,
          errorCode: null,
        }),
        TaskStatus.Error,
        {
          errorMessage: 'failed',
          errorCode: DownloadErrorCode.NetworkError,
        },
        9999
      )
    ).toEqual({
      status: TaskStatus.Error,
      finishedAt: 9999,
      errorMessage: 'failed',
      errorCode: DownloadErrorCode.NetworkError,
      errorDetailKey: null,
      errorDetailParams: null,
      diagnosisRevision: 0,
    })
  })

  it('clears failure details when an Error becomes Completed', () => {
    expect(
      applyTerminalTransition(
        fields({
          status: TaskStatus.Error,
          finishedAt: 1234,
          errorMessage: 'failed',
          errorCode: DownloadErrorCode.NetworkError,
          errorDetailKey: 'net.timeout',
          errorDetailParams: { host: 'example.com' },
          diagnosisRevision: 3,
        }),
        TaskStatus.Completed,
        {},
        9999
      )
    ).toEqual({
      status: TaskStatus.Completed,
      finishedAt: 9999,
      errorMessage: null,
      errorCode: null,
      errorDetailKey: null,
      errorDetailParams: null,
      diagnosisRevision: 0,
    })
  })

  it.each([
    TaskStatus.Queued,
    TaskStatus.Downloading,
    TaskStatus.Paused,
    TaskStatus.Seeding,
  ])('clears terminal metadata when moving to %s', (status) => {
    expect(
      applyTerminalTransition(
        fields({
          status: TaskStatus.Error,
          finishedAt: 1234,
          errorMessage: 'failed',
          errorCode: DownloadErrorCode.NetworkError,
          errorDetailKey: 'net.timeout',
          errorDetailParams: { host: 'example.com' },
          diagnosisRevision: 3,
        }),
        status,
        {},
        9999
      )
    ).toEqual({
      status,
      finishedAt: null,
      errorMessage: null,
      errorCode: null,
      errorDetailKey: null,
      errorDetailParams: null,
      diagnosisRevision: 0,
    })
  })

  it('ignores a normalized incoming snapshot on repeated Error and preserves the detail group', () => {
    const current = fields({
      status: TaskStatus.Error,
      finishedAt: 1234,
      errorMessage: 'original',
      errorCode: DownloadErrorCode.Timeout,
      errorDetailKey: 'net.timeout',
      errorDetailParams: { host: 'example.com' },
      diagnosisRevision: 3,
    })
    expect(
      applyTerminalTransition(
        current,
        TaskStatus.Error,
        { errorMessage: null, errorCode: null },
        9999
      )
    ).toEqual(current)
  })

  it('clears the full error detail group when leaving Error for Queued', () => {
    expect(
      applyTerminalTransition(
        fields({
          status: TaskStatus.Error,
          finishedAt: 1234,
          errorMessage: 'failed',
          errorCode: DownloadErrorCode.NetworkError,
          errorDetailKey: 'net.timeout',
          errorDetailParams: { host: 'example.com' },
          diagnosisRevision: 3,
        }),
        TaskStatus.Queued,
        {},
        9999
      )
    ).toEqual({
      status: TaskStatus.Queued,
      finishedAt: null,
      errorMessage: null,
      errorCode: null,
      errorDetailKey: null,
      errorDetailParams: null,
      diagnosisRevision: 0,
    })
  })

  it('writes provided detail fields on first entry into Error and carries diagnosisRevision from current', () => {
    expect(
      applyTerminalTransition(
        fields({
          status: TaskStatus.Downloading,
          finishedAt: null,
          errorMessage: null,
          errorCode: null,
          errorDetailKey: null,
          errorDetailParams: null,
          diagnosisRevision: 0,
        }),
        TaskStatus.Error,
        {
          errorMessage: 'failed',
          errorCode: DownloadErrorCode.NetworkError,
          errorDetailKey: 'net.timeout',
          errorDetailParams: { host: 'example.com' },
        },
        9999
      )
    ).toEqual({
      status: TaskStatus.Error,
      finishedAt: 9999,
      errorMessage: 'failed',
      errorCode: DownloadErrorCode.NetworkError,
      errorDetailKey: 'net.timeout',
      errorDetailParams: { host: 'example.com' },
      diagnosisRevision: 0,
    })
  })
})
