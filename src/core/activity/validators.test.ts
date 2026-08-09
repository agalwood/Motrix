import { describe, expect, it } from 'vitest'
import {
  MAX_TASK_ACTIVITY_DAYS,
  parseGetTaskActivityParams,
} from './validators'

const DAY_MS = 24 * 60 * 60 * 1_000
const BASE_MS = Date.UTC(2025, 0, 1)

function dateKey(index: number): string {
  return new Date(BASE_MS + index * DAY_MS).toISOString().slice(0, 10)
}

function makeDays(count: number, durationMs = DAY_MS) {
  return Array.from({ length: count }, (_, index) => ({
    dateKey: dateKey(index),
    fromMs: BASE_MS + index * durationMs,
    toMs: BASE_MS + (index + 1) * durationMs,
  }))
}

describe('getTaskActivityParamsSchema', () => {
  it('accepts contiguous 23-hour and 25-hour local days', () => {
    const firstEnd = BASE_MS + 23 * 60 * 60 * 1_000
    const params = {
      days: [
        {
          dateKey: '2025-03-09',
          fromMs: BASE_MS,
          toMs: firstEnd,
        },
        {
          dateKey: '2025-11-02',
          fromMs: firstEnd,
          toMs: firstEnd + 25 * 60 * 60 * 1_000,
        },
      ],
    }

    expect(parseGetTaskActivityParams(params)).toEqual(params)
  })

  it.each([
    ['gap', [{ ...makeDays(2)[1], fromMs: BASE_MS + DAY_MS + 1 }]],
    ['overlap', [{ ...makeDays(2)[1], fromMs: BASE_MS + DAY_MS - 1 }]],
    [
      'reverse order',
      [
        {
          dateKey: '2025-01-02',
          fromMs: BASE_MS + DAY_MS,
          toMs: BASE_MS + 2 * DAY_MS,
        },
        {
          dateKey: '2025-01-01',
          fromMs: BASE_MS,
          toMs: BASE_MS + DAY_MS,
        },
      ],
    ],
  ])('rejects %s intervals', (_label, replacement) => {
    const days =
      replacement.length === 1 ? [makeDays(2)[0], replacement[0]] : replacement
    expect(() => parseGetTaskActivityParams({ days })).toThrow()
  })

  it('rejects duplicate and malformed date keys', () => {
    const duplicate = makeDays(2)
    duplicate[1].dateKey = duplicate[0].dateKey
    expect(() => parseGetTaskActivityParams({ days: duplicate })).toThrow()
    expect(() =>
      parseGetTaskActivityParams({
        days: [{ ...makeDays(1)[0], dateKey: '2025-02-30' }],
      })
    ).toThrow()
    expect(() =>
      parseGetTaskActivityParams({
        days: [{ ...makeDays(1)[0], dateKey: '2025-1-1' }],
      })
    ).toThrow()
  })

  it.each([21, 27])('rejects a %s-hour day', (hours) => {
    expect(() =>
      parseGetTaskActivityParams({
        days: [
          {
            dateKey: '2025-01-01',
            fromMs: BASE_MS,
            toMs: BASE_MS + hours * 60 * 60 * 1_000,
          },
        ],
      })
    ).toThrow()
  })

  it('rejects more than 371 days and a range greater than 400 days', () => {
    expect(() =>
      parseGetTaskActivityParams({
        days: makeDays(MAX_TASK_ACTIVITY_DAYS + 1),
      })
    ).toThrow()
    expect(() =>
      parseGetTaskActivityParams({
        days: makeDays(MAX_TASK_ACTIVITY_DAYS, 26 * 60 * 60 * 1_000),
      })
    ).toThrow()
  })

  it('rejects unsafe integer timestamps', () => {
    expect(() =>
      parseGetTaskActivityParams({
        days: [
          {
            dateKey: '2025-01-01',
            fromMs: Number.MAX_SAFE_INTEGER + 1,
            toMs: Number.MAX_SAFE_INTEGER + 1 + DAY_MS,
          },
        ],
      })
    ).toThrow()
  })
})
