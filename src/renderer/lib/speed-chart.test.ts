import type { SpeedPoint } from '@shared/types/stats'
import { describe, expect, it } from 'vitest'
import {
  activityTimeDomain,
  normalizeObservedSpeedHistory,
} from './speed-chart'

describe('Activity speed chart utilities', () => {
  it('never pads observed history with synthetic points', () => {
    const point: SpeedPoint = { t: 1_000, down: 10, up: 2 }
    expect(normalizeObservedSpeedHistory([point], 60)).toEqual([point])
  })

  it('sorts real points without mutating input and applies the requested cap', () => {
    const input: SpeedPoint[] = [
      { t: 3, down: 3, up: 0 },
      { t: 1, down: 1, up: 0 },
      { t: 2, down: 2, up: 0 },
    ]
    expect(normalizeObservedSpeedHistory(input, 2)).toEqual([
      { t: 2, down: 2, up: 0 },
      { t: 3, down: 3, up: 0 },
    ])
    expect(input.map((point) => point.t)).toEqual([3, 1, 2])
  })

  it('uses no domain for zero points and a symmetric display domain for one', () => {
    expect(activityTimeDomain([])).toBeNull()
    expect(activityTimeDomain([{ t: 1_000, down: 1, up: 0 }])).toEqual([
      500, 1_500,
    ])
  })

  it('uses exact first and last timestamps for two or more points', () => {
    expect(
      activityTimeDomain([
        { t: 1_000, down: 1, up: 0 },
        { t: 2_500, down: 2, up: 0 },
      ])
    ).toEqual([1_000, 2_500])
  })
})
