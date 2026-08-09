import { TaskStatus } from '@shared/types/task'
import {
  TaskHistoryAccuracy,
  TaskHistoryDelivery,
  TaskHistoryEventKind,
} from '@shared/types/task-inspector-activity'
import { describe, expect, it } from 'vitest'
import {
  assertNonNegativeBigInt,
  assertNonNegativeSafeInteger,
  assertPositiveSafeInteger,
  assertTaskId,
  MAX_ERROR_DETAIL_KEY_LENGTH,
  MAX_ERROR_DETAIL_PARAMS_JSON_LENGTH,
  MAX_SIGNED_SQLITE_INTEGER,
  normalizeSpeed,
  saturatingAddSignedInt64,
  validateCheckpoint,
  validateHistoryEventInput,
} from './validators'

describe('task inspector activity validators', () => {
  it('validates task IDs and safe positive timestamps', () => {
    expect(assertTaskId(' task-1 ')).toBe('task-1')
    expect(() => assertTaskId('')).toThrow(RangeError)
    expect(() => assertTaskId('   ')).toThrow(RangeError)
    expect(() => assertTaskId('x'.repeat(1025))).toThrow(RangeError)
    expect(() => assertTaskId(`${' '.repeat(1025)}task-1`)).toThrow(RangeError)
    expect(assertPositiveSafeInteger(1, 'time')).toBe(1)
    expect(() => assertPositiveSafeInteger(0, 'time')).toThrow(RangeError)
    expect(() =>
      assertPositiveSafeInteger(Number.MAX_SAFE_INTEGER + 1, 'time')
    ).toThrow(RangeError)
  })

  it('normalizes finite non-negative speeds exactly once', () => {
    expect(normalizeSpeed(1.49, 'speed')).toBe(1)
    expect(normalizeSpeed(1.5, 'speed')).toBe(2)
    expect(normalizeSpeed(Number.MAX_SAFE_INTEGER, 'speed')).toBe(
      Number.MAX_SAFE_INTEGER
    )
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => normalizeSpeed(bad, 'speed')).toThrow(RangeError)
    }
  })

  it('validates non-negative summary deltas and saturates signed int64', () => {
    expect(assertNonNegativeSafeInteger(0, 'delta')).toBe(0)
    expect(assertNonNegativeBigInt(0n, 'bytes')).toBe(0n)
    expect(() => assertNonNegativeSafeInteger(-1, 'delta')).toThrow(RangeError)
    expect(() => assertNonNegativeBigInt(-1n, 'bytes')).toThrow(RangeError)

    expect(saturatingAddSignedInt64(10n, 20n)).toEqual({
      value: 30n,
      saturated: false,
    })
    expect(
      saturatingAddSignedInt64(MAX_SIGNED_SQLITE_INTEGER - 1n, 10n)
    ).toEqual({
      value: MAX_SIGNED_SQLITE_INTEGER,
      saturated: true,
    })
  })

  it('returns one normalized checkpoint value for persistence', () => {
    expect(
      validateCheckpoint({
        taskId: ' task-1 ',
        updatedAt: 1,
        activeMsDelta: 0,
        downloadActiveMsDelta: 0,
        estimatedDownloadBytesDelta: 0n,
        estimatedUploadBytesDelta: 0n,
        peakDownloadBps: 1.5,
        peakUploadBps: 2.5,
        rawSampleCountDelta: 1,
        samples: [{ t: 1, down: 3.5, up: 4.5, flags: 0 }],
      })
    ).toMatchObject({
      taskId: 'task-1',
      peakDownloadBps: 2,
      peakUploadBps: 3,
      samples: [{ t: 1, down: 4, up: 5, flags: 0 }],
    })
  })

  it('accepts legal event mappings and rejects impossible mappings', () => {
    const base = {
      taskId: 'task-1',
      eventOrdinal: 1,
      eventKey: 'runtime-1:1',
      runtimeGeneration: 'runtime-1',
      occurredAt: 10,
      occurredMonotonicMs: 5,
      accuracy: TaskHistoryAccuracy.Exact,
      delivery: TaskHistoryDelivery.Initial,
      errorCode: null,
      errorMessage: null,
      errorDetailKey: null,
      errorDetailParams: null,
    } as const

    expect(() =>
      validateHistoryEventInput({
        ...base,
        kind: TaskHistoryEventKind.Paused,
        fromStatus: TaskStatus.Downloading,
        toStatus: TaskStatus.Paused,
      })
    ).not.toThrow()
    expect(() =>
      validateHistoryEventInput({
        ...base,
        kind: TaskHistoryEventKind.Paused,
        fromStatus: TaskStatus.Finalizing,
        toStatus: TaskStatus.Paused,
      })
    ).not.toThrow()
    expect(() =>
      validateHistoryEventInput({
        ...base,
        kind: TaskHistoryEventKind.ObservedState,
        fromStatus: null,
        toStatus: TaskStatus.Downloading,
        accuracy: TaskHistoryAccuracy.Recovered,
      })
    ).not.toThrow()
    expect(() =>
      validateHistoryEventInput({
        ...base,
        kind: TaskHistoryEventKind.Completed,
        fromStatus: TaskStatus.Downloading,
        toStatus: TaskStatus.Error,
      })
    ).toThrow(RangeError)
    expect(() =>
      validateHistoryEventInput({
        ...base,
        kind: TaskHistoryEventKind.ObservedState,
        fromStatus: null,
        toStatus: TaskStatus.Downloading,
      })
    ).toThrow(RangeError)
    expect(() =>
      validateHistoryEventInput({
        ...base,
        kind: TaskHistoryEventKind.StageChanged,
        fromStatus: TaskStatus.Downloading,
        toStatus: null as never,
      })
    ).toThrow(RangeError)
  })

  it('bounds errorDetailKey and errorDetailParams like errorCode/errorMessage', () => {
    const base = {
      taskId: 'task-1',
      eventOrdinal: 1,
      eventKey: 'runtime-1:1',
      runtimeGeneration: 'runtime-1',
      occurredAt: 10,
      occurredMonotonicMs: 5,
      accuracy: TaskHistoryAccuracy.Exact,
      delivery: TaskHistoryDelivery.Initial,
      kind: TaskHistoryEventKind.Failed,
      fromStatus: TaskStatus.Downloading,
      toStatus: TaskStatus.Error,
      errorCode: null,
      errorMessage: null,
    } as const

    expect(() =>
      validateHistoryEventInput({
        ...base,
        errorDetailKey: 'task.error.detail.filesMissing',
        errorDetailParams: { cause: 'missing' },
      })
    ).not.toThrow()
    expect(() =>
      validateHistoryEventInput({
        ...base,
        errorDetailKey: 'x'.repeat(MAX_ERROR_DETAIL_KEY_LENGTH + 1),
        errorDetailParams: null,
      })
    ).toThrow(RangeError)
    expect(() =>
      validateHistoryEventInput({
        ...base,
        errorDetailKey: '',
        errorDetailParams: null,
      })
    ).toThrow(RangeError)
    expect(() =>
      validateHistoryEventInput({
        ...base,
        errorDetailKey: null,
        errorDetailParams: {
          cause: 'x'.repeat(MAX_ERROR_DETAIL_PARAMS_JSON_LENGTH),
        },
      })
    ).toThrow(RangeError)
    expect(() =>
      validateHistoryEventInput({
        ...base,
        errorDetailKey: null,
        errorDetailParams: { cause: 1 } as unknown as Record<string, string>,
      })
    ).toThrow(RangeError)
  })
})
