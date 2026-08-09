import type { GetTaskActivityParams } from '@shared/types/task-activity'
import { z } from 'zod'

export const MAX_TASK_ACTIVITY_DAYS = 371

const MIN_LOCAL_DAY_MS = 22 * 60 * 60 * 1_000
const MAX_LOCAL_DAY_MS = 26 * 60 * 60 * 1_000
const MAX_TASK_ACTIVITY_RANGE_MS = 400 * 24 * 60 * 60 * 1_000
const DATE_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

const safeIntegerSchema = z
  .number()
  .int()
  .refine(Number.isSafeInteger, 'Expected a JavaScript safe integer')

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function isCanonicalDateKey(dateKey: string): boolean {
  const match = DATE_KEY_PATTERN.exec(dateKey)
  if (!match) return false

  const [year, month, day] = dateKey.split('-').map(Number)
  const monthLengths = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ]
  return day <= (monthLengths[month - 1] ?? 0)
}

const taskActivityDayBoundarySchema = z
  .object({
    dateKey: z.string().refine(isCanonicalDateKey, {
      message: 'Expected a canonical YYYY-MM-DD date key',
    }),
    fromMs: safeIntegerSchema,
    toMs: safeIntegerSchema,
  })
  .strict()

export const getTaskActivityParamsSchema = z
  .object({
    days: z
      .array(taskActivityDayBoundarySchema)
      .min(1)
      .max(MAX_TASK_ACTIVITY_DAYS),
  })
  .strict()
  .superRefine(({ days }, context) => {
    const dateKeys = new Set<string>()

    for (const [index, day] of days.entries()) {
      if (dateKeys.has(day.dateKey)) {
        context.addIssue({
          code: 'custom',
          message: 'Date keys must be unique',
          path: ['days', index, 'dateKey'],
        })
      }
      dateKeys.add(day.dateKey)

      const duration = BigInt(day.toMs) - BigInt(day.fromMs)
      if (
        duration < BigInt(MIN_LOCAL_DAY_MS) ||
        duration > BigInt(MAX_LOCAL_DAY_MS)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Each local day must be between 22 and 26 hours',
          path: ['days', index, 'toMs'],
        })
      }

      const previous = days[index - 1]
      if (!previous) continue

      if (day.fromMs <= previous.fromMs) {
        context.addIssue({
          code: 'custom',
          message: 'Day intervals must be strictly increasing',
          path: ['days', index, 'fromMs'],
        })
      }
      if (day.fromMs !== previous.toMs) {
        context.addIssue({
          code: 'custom',
          message:
            'Day intervals must be contiguous, non-overlapping, and half-open',
          path: ['days', index, 'fromMs'],
        })
      }
    }

    const first = days[0]
    const last = days.at(-1)
    if (
      first &&
      last &&
      BigInt(last.toMs) - BigInt(first.fromMs) >
        BigInt(MAX_TASK_ACTIVITY_RANGE_MS)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Activity range must not exceed 400 days',
        path: ['days'],
      })
    }
  })

export function parseGetTaskActivityParams(
  input: unknown
): GetTaskActivityParams {
  return getTaskActivityParamsSchema.parse(input)
}
