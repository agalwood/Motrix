import type { SpeedPoint } from '@shared/types/stats'
import { describe, expect, it } from 'vitest'
import {
  activityTimeDomain,
  normalizeObservedSpeedHistory,
  sampleSpeedHistory,
} from './speed-chart'

describe('Dashboard speed chart sampling', () => {
  it.each(['up', 'down'] as const)(
    'reduces dense %s history while preserving observed points, time bounds, and the peak',
    (direction) => {
      const history = Array.from({ length: 200 }, (_, index) => ({
        t: 1_000 + index * 1_000,
        up: index === 83 ? 1_000 : 100 + (index % 7) * 10,
        down: index === 127 ? 2_000 : 200 + (index % 11) * 10,
      }))
      const original = structuredClone(history)
      const sampled = sampleSpeedHistory(history, 16, direction)

      expect(sampled).toHaveLength(16)
      expect(sampled[0]).toBe(history[0])
      expect(sampled.at(-1)).toBe(history.at(-1))
      expect(Math.max(...sampled.map((point) => point[direction]))).toBe(
        Math.max(...history.map((point) => point[direction]))
      )
      for (let index = 1; index < sampled.length; index++) {
        expect(history).toContain(sampled[index])
        expect(sampled[index].t).toBeGreaterThan(sampled[index - 1].t)
      }
      expect(history).toEqual(original)
      expect(sampleSpeedHistory(history, 32, direction)).toHaveLength(32)
    }
  )

  it('retains short histories and keeps idle data flat', () => {
    const history = Array.from({ length: 200 }, (_, t) => ({
      t,
      up: 0,
      down: 0,
    }))
    const short = history.slice(0, 3)
    expect(sampleSpeedHistory(short, 16, 'up')).toBe(short)
    expect(sampleSpeedHistory([], 16, 'up')).toEqual([])
    expect(sampleSpeedHistory(history, 16, 'up')).toHaveLength(16)
    expect(
      sampleSpeedHistory(history, 16, 'up').every(
        (point) => point.up === 0 && point.down === 0
      )
    ).toBe(true)
  })
})

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
