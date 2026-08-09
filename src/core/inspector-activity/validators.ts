import { TaskStatus } from '@shared/types/task'
import {
  type TaskActivityCheckpoint,
  TaskHistoryAccuracy,
  TaskHistoryDelivery,
  type TaskHistoryEventInput,
  TaskHistoryEventKind,
  type TaskTransferSample,
} from '@shared/types/task-inspector-activity'

export const MAX_SAFE_SQLITE_INTEGER = Number.MAX_SAFE_INTEGER
export const MAX_SIGNED_SQLITE_INTEGER = 9_223_372_036_854_775_807n
export const MAX_TASK_ID_LENGTH = 1_024
export const MAX_EVENT_KEY_LENGTH = 256
export const MAX_ERROR_CODE_LENGTH = 128
export const MAX_ERROR_MESSAGE_LENGTH = 2_048
export const MAX_ERROR_DETAIL_KEY_LENGTH = 128
export const MAX_ERROR_DETAIL_PARAMS_JSON_LENGTH = 2_048
export const MAX_SAMPLE_FLAGS = 2_147_483_647

const STATUS_VALUES = new Set<string>(Object.values(TaskStatus))
const EVENT_KIND_VALUES = new Set<string>(Object.values(TaskHistoryEventKind))
const ACCURACY_VALUES = new Set<string>(Object.values(TaskHistoryAccuracy))
const DELIVERY_VALUES = new Set<string>(Object.values(TaskHistoryDelivery))
const ACTIVE_RESUME_STATUSES = new Set<TaskStatus>([
  TaskStatus.FetchingMetadata,
  TaskStatus.Downloading,
  TaskStatus.Finalizing,
  TaskStatus.Seeding,
])

export function assertTaskId(taskId: string): string {
  if (typeof taskId !== 'string') {
    throw new RangeError('taskId must be a string')
  }
  if (taskId.length > MAX_TASK_ID_LENGTH) {
    throw new RangeError(
      `taskId must contain between 1 and ${MAX_TASK_ID_LENGTH} characters`
    )
  }
  const normalized = taskId.trim()
  if (normalized.length === 0 || normalized.length > MAX_TASK_ID_LENGTH) {
    throw new RangeError(
      `taskId must contain between 1 and ${MAX_TASK_ID_LENGTH} characters`
    )
  }
  return normalized
}

export function assertPositiveSafeInteger(
  value: number,
  label: string
): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
  return value
}

export function assertNonNegativeSafeInteger(
  value: number,
  label: string
): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
  return value
}

export function assertNonNegativeBigInt(value: bigint, label: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new RangeError(`${label} must be a non-negative bigint`)
  }
  return value
}

export function normalizeSpeed(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and non-negative`)
  }
  const normalized = Math.round(value)
  if (!Number.isSafeInteger(normalized)) {
    throw new RangeError(`${label} exceeds the JavaScript safe integer range`)
  }
  return normalized
}

export function saturatingAddSignedInt64(
  current: bigint,
  delta: bigint
): { value: bigint; saturated: boolean } {
  assertNonNegativeBigInt(current, 'current')
  assertNonNegativeBigInt(delta, 'delta')
  if (current > MAX_SIGNED_SQLITE_INTEGER) {
    throw new RangeError('current exceeds the signed int64 range')
  }
  if (delta > MAX_SIGNED_SQLITE_INTEGER - current) {
    return { value: MAX_SIGNED_SQLITE_INTEGER, saturated: true }
  }
  return { value: current + delta, saturated: false }
}

export function saturatingAddSafeInteger(
  current: number,
  delta: number
): { value: number; saturated: boolean } {
  assertNonNegativeSafeInteger(current, 'current')
  assertNonNegativeSafeInteger(delta, 'delta')
  if (delta > MAX_SAFE_SQLITE_INTEGER - current) {
    return { value: MAX_SAFE_SQLITE_INTEGER, saturated: true }
  }
  return { value: current + delta, saturated: false }
}

function assertBoundedText(
  value: string | null,
  label: string,
  maxLength: number
): void {
  if (value === null) return
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new RangeError(
      `${label} must contain between 1 and ${maxLength} characters`
    )
  }
}

function assertStatus(value: TaskStatus | null, label: string): void {
  if (value !== null && !STATUS_VALUES.has(value)) {
    throw new RangeError(`${label} is not a legal task status`)
  }
}

function assertBoundedDetailParams(
  value: Record<string, string> | null,
  label: string,
  maxJsonLength: number
): void {
  if (value === null) return
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.values(value).some((entry) => typeof entry !== 'string')
  ) {
    throw new RangeError(`${label} must be a flat string record`)
  }
  const serialized = JSON.stringify(value)
  if (serialized.length > maxJsonLength) {
    throw new RangeError(
      `${label} JSON must not exceed ${maxJsonLength} characters`
    )
  }
}

export function validateHistoryEventInput(input: TaskHistoryEventInput): void {
  assertTaskId(input.taskId)
  assertPositiveSafeInteger(input.eventOrdinal, 'eventOrdinal')
  assertBoundedText(input.eventKey, 'eventKey', MAX_EVENT_KEY_LENGTH)
  assertBoundedText(
    input.runtimeGeneration,
    'runtimeGeneration',
    MAX_EVENT_KEY_LENGTH
  )
  assertPositiveSafeInteger(input.occurredAt, 'occurredAt')
  assertNonNegativeSafeInteger(input.occurredMonotonicMs, 'occurredMonotonicMs')
  if (!EVENT_KIND_VALUES.has(input.kind)) {
    throw new RangeError('kind is not a legal history event kind')
  }
  if (!ACCURACY_VALUES.has(input.accuracy)) {
    throw new RangeError('accuracy is not legal')
  }
  if (!DELIVERY_VALUES.has(input.delivery)) {
    throw new RangeError('delivery is not legal')
  }
  assertStatus(input.fromStatus, 'fromStatus')
  assertStatus(input.toStatus, 'toStatus')
  if (input.toStatus === null) {
    throw new RangeError('toStatus is required')
  }
  assertBoundedText(input.errorCode, 'errorCode', MAX_ERROR_CODE_LENGTH)
  assertBoundedText(
    input.errorMessage,
    'errorMessage',
    MAX_ERROR_MESSAGE_LENGTH
  )
  assertBoundedText(
    input.errorDetailKey,
    'errorDetailKey',
    MAX_ERROR_DETAIL_KEY_LENGTH
  )
  assertBoundedDetailParams(
    input.errorDetailParams,
    'errorDetailParams',
    MAX_ERROR_DETAIL_PARAMS_JSON_LENGTH
  )

  switch (input.kind) {
    case TaskHistoryEventKind.Added:
      if (input.fromStatus !== null) {
        throw new RangeError('Added must not have a fromStatus')
      }
      break
    case TaskHistoryEventKind.Started:
      if (!ACTIVE_RESUME_STATUSES.has(input.toStatus)) {
        throw new RangeError('Started must enter an active status')
      }
      break
    case TaskHistoryEventKind.Paused:
      if (
        input.fromStatus === null ||
        !ACTIVE_RESUME_STATUSES.has(input.fromStatus) ||
        input.toStatus !== TaskStatus.Paused
      ) {
        throw new RangeError('Paused must transition from active to paused')
      }
      break
    case TaskHistoryEventKind.Resumed:
      if (
        input.fromStatus !== TaskStatus.Paused ||
        !ACTIVE_RESUME_STATUSES.has(input.toStatus)
      ) {
        throw new RangeError('Resumed must transition from paused to active')
      }
      break
    case TaskHistoryEventKind.Completed:
      if (input.toStatus !== TaskStatus.Completed) {
        throw new RangeError('Completed must end in completed')
      }
      break
    case TaskHistoryEventKind.Failed:
      if (input.toStatus !== TaskStatus.Error) {
        throw new RangeError('Failed must end in error')
      }
      break
    case TaskHistoryEventKind.ObservedState:
      if (input.accuracy !== TaskHistoryAccuracy.Recovered) {
        throw new RangeError('Observed state must be recovered')
      }
      break
    case TaskHistoryEventKind.StageChanged:
      break
  }
}

export function normalizeTransferSamples(
  samples: readonly TaskTransferSample[]
): TaskTransferSample[] {
  return samples.map((sample, index) => ({
    t: assertPositiveSafeInteger(sample.t, `samples[${index}].t`),
    down: normalizeSpeed(sample.down, `samples[${index}].down`),
    up: normalizeSpeed(sample.up, `samples[${index}].up`),
    flags: (() => {
      const flags = assertNonNegativeSafeInteger(
        sample.flags,
        `samples[${index}].flags`
      )
      if (flags > MAX_SAMPLE_FLAGS) {
        throw new RangeError(`samples[${index}].flags exceeds the SQLite bound`)
      }
      return flags
    })(),
  }))
}

export function validateCheckpoint(
  input: TaskActivityCheckpoint
): TaskActivityCheckpoint {
  const taskId = assertTaskId(input.taskId)
  assertPositiveSafeInteger(input.updatedAt, 'updatedAt')
  assertNonNegativeSafeInteger(input.activeMsDelta, 'activeMsDelta')
  assertNonNegativeSafeInteger(
    input.downloadActiveMsDelta,
    'downloadActiveMsDelta'
  )
  assertNonNegativeBigInt(
    input.estimatedDownloadBytesDelta,
    'estimatedDownloadBytesDelta'
  )
  assertNonNegativeBigInt(
    input.estimatedUploadBytesDelta,
    'estimatedUploadBytesDelta'
  )
  const peakDownloadBps = normalizeSpeed(
    input.peakDownloadBps,
    'peakDownloadBps'
  )
  const peakUploadBps = normalizeSpeed(input.peakUploadBps, 'peakUploadBps')
  assertNonNegativeSafeInteger(input.rawSampleCountDelta, 'rawSampleCountDelta')
  if (input.coverageGapAt !== undefined) {
    assertPositiveSafeInteger(input.coverageGapAt, 'coverageGapAt')
  }
  return {
    ...input,
    taskId,
    peakDownloadBps,
    peakUploadBps,
    samples: normalizeTransferSamples(input.samples),
  }
}
