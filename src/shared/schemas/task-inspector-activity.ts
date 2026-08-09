import type { SpeedPoint } from '@shared/types/stats'
import { TaskStatus } from '@shared/types/task'
import {
  TaskHistoryAccuracy,
  TaskHistoryEventKind,
  type TaskInspectorActivitySnapshot,
  type TaskInspectorActivityUpdatedPayload,
  TaskInspectorActivityUpdateReason,
} from '@shared/types/task-inspector-activity'
import { z } from 'zod'

export const TASK_INSPECTOR_ACTIVITY_MAX_TASK_ID_LENGTH = 1_024
export const TASK_INSPECTOR_ACTIVITY_MAX_EVENT_KEY_LENGTH = 256
export const TASK_INSPECTOR_ACTIVITY_MAX_ERROR_CODE_LENGTH = 128
export const TASK_INSPECTOR_ACTIVITY_MAX_ERROR_MESSAGE_LENGTH = 2_048
export const TASK_INSPECTOR_ACTIVITY_MAX_ERROR_DETAIL_KEY_LENGTH = 128
export const TASK_INSPECTOR_ACTIVITY_MAX_ERROR_DETAIL_PARAMS_JSON_LENGTH = 2_048
export const TASK_INSPECTOR_ACTIVITY_MAX_EVENTS = 512
export const TASK_INSPECTOR_ACTIVITY_MAX_LIFETIME_POINTS = 96
export const TASK_SPEED_HISTORY_MAX_POINTS = 60

const MAX_SAMPLE_FLAGS = 2_147_483_647
const MAX_SIGNED_64_BIT_INTEGER = 9_223_372_036_854_775_807n
const INVALID_CLONE = Symbol('invalid-clone')

interface CloneLimits {
  maxArrayLength: number
  maxNodes: number
  maxObjectKeys: number
}

interface CloneState {
  ancestors: WeakSet<object>
  limits: CloneLimits
  nodes: number
}

function cloneDataOnlyValue(
  value: unknown,
  state: CloneState
): unknown | typeof INVALID_CLONE {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value
  }
  if (typeof value !== 'object') return INVALID_CLONE

  state.nodes += 1
  if (state.nodes > state.limits.maxNodes || state.ancestors.has(value)) {
    return INVALID_CLONE
  }
  state.ancestors.add(value)

  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        return INVALID_CLONE
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
      if (
        !lengthDescriptor ||
        !('value' in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > state.limits.maxArrayLength
      ) {
        return INVALID_CLONE
      }

      const clone: unknown[] = []
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !('value' in descriptor)) return INVALID_CLONE
        const item = cloneDataOnlyValue(descriptor.value, state)
        if (item === INVALID_CLONE) return INVALID_CLONE
        clone.push(item)
      }
      return clone
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      return INVALID_CLONE
    }
    const keys = Reflect.ownKeys(value)
    if (
      keys.length > state.limits.maxObjectKeys ||
      keys.some((key) => typeof key !== 'string')
    ) {
      return INVALID_CLONE
    }

    const clone = Object.create(null) as Record<string, unknown>
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) return INVALID_CLONE
      const item = cloneDataOnlyValue(descriptor.value, state)
      if (item === INVALID_CLONE) return INVALID_CLONE
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: item,
        writable: true,
      })
    }
    return clone
  } catch {
    return INVALID_CLONE
  } finally {
    state.ancestors.delete(value)
  }
}

function cloneBoundedDataOnlyValue(
  value: unknown,
  limits: CloneLimits
): unknown | typeof INVALID_CLONE {
  return cloneDataOnlyValue(value, {
    ancestors: new WeakSet(),
    limits,
    nodes: 0,
  })
}

const nonNegativeSafeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
const positiveSafeIntegerSchema = nonNegativeSafeIntegerSchema.min(1)
const nullablePositiveSafeIntegerSchema = positiveSafeIntegerSchema.nullable()
const taskIdSchema = z
  .string()
  .min(1)
  .max(TASK_INSPECTOR_ACTIVITY_MAX_TASK_ID_LENGTH)
const serializedByteCountSchema = z.string().refine((value) => {
  if (value.length > 19 || !/^(0|[1-9]\d*)$/.test(value)) return false
  return BigInt(value) <= MAX_SIGNED_64_BIT_INTEGER
})
const nullableBoundedTextSchema = (maxLength: number) =>
  z.string().min(1).max(maxLength).nullable()
const nullableDetailParamsSchema = z
  .record(z.string(), z.string())
  .nullable()
  .refine(
    (value) =>
      value === null ||
      JSON.stringify(value).length <=
        TASK_INSPECTOR_ACTIVITY_MAX_ERROR_DETAIL_PARAMS_JSON_LENGTH,
    { message: 'errorDetailParams JSON exceeds the bound' }
  )

const speedPointSchema = z
  .object({
    t: nonNegativeSafeIntegerSchema,
    down: nonNegativeSafeIntegerSchema,
    up: nonNegativeSafeIntegerSchema,
  })
  .strict()

const transferSampleSchema = speedPointSchema
  .extend({
    t: positiveSafeIntegerSchema,
    flags: nonNegativeSafeIntegerSchema.max(MAX_SAMPLE_FLAGS),
  })
  .strict()

const historyEventSchema = z
  .object({
    eventOrdinal: positiveSafeIntegerSchema,
    eventKey: z
      .string()
      .min(1)
      .max(TASK_INSPECTOR_ACTIVITY_MAX_EVENT_KEY_LENGTH),
    kind: z.enum(TaskHistoryEventKind),
    fromStatus: z.enum(TaskStatus).nullable(),
    toStatus: z.enum(TaskStatus),
    occurredAt: positiveSafeIntegerSchema,
    accuracy: z.enum(TaskHistoryAccuracy),
    errorCode: nullableBoundedTextSchema(
      TASK_INSPECTOR_ACTIVITY_MAX_ERROR_CODE_LENGTH
    ),
    errorMessage: nullableBoundedTextSchema(
      TASK_INSPECTOR_ACTIVITY_MAX_ERROR_MESSAGE_LENGTH
    ),
    // Absent-tolerant, unlike the fields above: a snapshot produced by a
    // build from before the error-detail fields existed carries neither
    // key, and a strict required field would reject the whole timeline
    // rather than degrade one item. Missing normalizes to null.
    errorDetailKey: nullableBoundedTextSchema(
      TASK_INSPECTOR_ACTIVITY_MAX_ERROR_DETAIL_KEY_LENGTH
    ).default(null),
    errorDetailParams: nullableDetailParamsSchema.default(null),
  })
  .strict()

const taskInspectorActivitySnapshotSchema = z
  .object({
    taskId: taskIdSchema,
    revision: nonNegativeSafeIntegerSchema,
    summary: z
      .object({
        trackingStartedAt: positiveSafeIntegerSchema,
        coverageGapAt: nullablePositiveSafeIntegerSchema,
        revision: nonNegativeSafeIntegerSchema,
        lastEventOrdinal: nonNegativeSafeIntegerSchema,
        activeMs: nonNegativeSafeIntegerSchema,
        downloadActiveMs: nonNegativeSafeIntegerSchema,
        estimatedDownloadBytes: serializedByteCountSchema,
        estimatedUploadBytes: serializedByteCountSchema,
        peakDownloadBps: nonNegativeSafeIntegerSchema,
        peakUploadBps: nonNegativeSafeIntegerSchema,
        rawSampleCount: nonNegativeSafeIntegerSchema,
        historyDroppedCount: nonNegativeSafeIntegerSchema,
        historyTruncatedAt: nullablePositiveSafeIntegerSchema,
        updatedAt: positiveSafeIntegerSchema,
      })
      .strict(),
    timeline: z
      .object({
        events: z
          .array(historyEventSchema)
          .max(TASK_INSPECTOR_ACTIVITY_MAX_EVENTS),
        trackingStartedAt: positiveSafeIntegerSchema,
        coverageGapAt: nullablePositiveSafeIntegerSchema,
        historyDroppedCount: nonNegativeSafeIntegerSchema,
        historyTruncatedAt: nullablePositiveSafeIntegerSchema,
      })
      .strict(),
    lifetime: z
      .object({
        points: z
          .array(transferSampleSchema)
          .max(TASK_INSPECTOR_ACTIVITY_MAX_LIFETIME_POINTS),
        averageDownloadSpeed: nonNegativeSafeIntegerSchema,
        peakDownloadSpeed: nonNegativeSafeIntegerSchema,
        peakUploadSpeed: nonNegativeSafeIntegerSchema,
        activeMs: nonNegativeSafeIntegerSchema,
        updatedAt: positiveSafeIntegerSchema,
        accuracy: z.literal('estimated'),
      })
      .strict(),
  })
  .strict()
  .refine((value) => value.revision === value.summary.revision, {
    message: 'snapshot and summary revisions must match',
  })
  .refine(
    (value) =>
      value.timeline.trackingStartedAt === value.summary.trackingStartedAt &&
      value.timeline.coverageGapAt === value.summary.coverageGapAt &&
      value.timeline.historyDroppedCount ===
        value.summary.historyDroppedCount &&
      value.timeline.historyTruncatedAt === value.summary.historyTruncatedAt,
    {
      message: 'timeline metadata must match the summary',
    }
  )
  .refine(
    (value) =>
      value.lifetime.peakDownloadSpeed === value.summary.peakDownloadBps &&
      value.lifetime.peakUploadSpeed === value.summary.peakUploadBps &&
      value.lifetime.activeMs === value.summary.activeMs &&
      value.lifetime.updatedAt === value.summary.updatedAt,
    {
      message: 'lifetime metadata must match the summary',
    }
  )

const activityUpdateSchema = z
  .object({
    taskId: taskIdSchema,
    revision: nonNegativeSafeIntegerSchema,
    reason: z.enum(TaskInspectorActivityUpdateReason),
  })
  .strict()

const taskSpeedUpdateSchema = z
  .object({
    id: taskIdSchema,
    status: z.enum(TaskStatus),
    downloadSpeed: nonNegativeSafeIntegerSchema,
    uploadSpeed: nonNegativeSafeIntegerSchema,
  })
  .strict()

export interface TaskSpeedUpdate {
  id: string
  status: TaskStatus
  downloadSpeed: number
  uploadSpeed: number
}

export function parseTaskInspectorActivitySnapshot(
  value: unknown,
  expectedTaskId?: string
): TaskInspectorActivitySnapshot | null {
  const clone = cloneBoundedDataOnlyValue(value, {
    maxArrayLength: TASK_INSPECTOR_ACTIVITY_MAX_EVENTS,
    maxNodes: 1_024,
    maxObjectKeys: 32,
  })
  if (clone === INVALID_CLONE) return null
  const parsed = taskInspectorActivitySnapshotSchema.safeParse(clone)
  if (
    !parsed.success ||
    (expectedTaskId !== undefined && parsed.data.taskId !== expectedTaskId)
  ) {
    return null
  }
  return parsed.data
}

export function parseTaskInspectorActivityUpdate(
  value: unknown
): TaskInspectorActivityUpdatedPayload | null {
  const clone = cloneBoundedDataOnlyValue(value, {
    maxArrayLength: 0,
    maxNodes: 1,
    maxObjectKeys: 3,
  })
  if (clone === INVALID_CLONE) return null
  const parsed = activityUpdateSchema.safeParse(clone)
  return parsed.success ? parsed.data : null
}

export function parseTaskSpeedHistory(value: unknown): SpeedPoint[] | null {
  const clone = cloneBoundedDataOnlyValue(value, {
    maxArrayLength: TASK_SPEED_HISTORY_MAX_POINTS,
    maxNodes: TASK_SPEED_HISTORY_MAX_POINTS + 1,
    maxObjectKeys: 3,
  })
  if (clone === INVALID_CLONE) return null
  const parsed = z
    .array(speedPointSchema)
    .max(TASK_SPEED_HISTORY_MAX_POINTS)
    .safeParse(clone)
  return parsed.success ? parsed.data : null
}

function extractTaskSpeedUpdate(value: unknown): TaskSpeedUpdate | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  try {
    if (Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const extracted = Object.create(null) as Record<string, unknown>
    for (const key of [
      'id',
      'status',
      'downloadSpeed',
      'uploadSpeed',
    ] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) return null
      extracted[key] = descriptor.value
    }
    const parsed = taskSpeedUpdateSchema.safeParse(extracted)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function findTaskSpeedUpdate(
  value: unknown,
  taskId: string
): TaskSpeedUpdate | null {
  try {
    if (!Array.isArray(value)) return null
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (
      !lengthDescriptor ||
      !('value' in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      return null
    }
    let match: TaskSpeedUpdate | null = null
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue
      if (typeof key !== 'string') return null
      const index = Number(key)
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= lengthDescriptor.value ||
        String(index) !== key
      ) {
        return null
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) continue
      const update = extractTaskSpeedUpdate(descriptor.value)
      if (update?.id === taskId && match === null) match = update
    }
    return match
  } catch {
    return null
  }
}
