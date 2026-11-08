import { setAppReduceMotion } from '@renderer/lib/reduced-motion'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  interpolateActivitySamples,
  useActivityChartMotion,
} from './use-activity-chart-motion'

describe('activity chart motion', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    setAppReduceMotion(false)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    setAppReduceMotion(false)
  })
  it('moves time linearly and settles vertical changes in 300ms', () => {
    const interpolate = interpolateActivitySamples(1000)
    const items = [
      {
        status: 'matched' as const,
        prev: { x: 120, y: 80 },
        next: { x: 100, y: 40 },
      },
      { status: 'added' as const, next: { x: 140, y: 20 } },
    ]
    expect(interpolate(items, 0.15, 'horizontal')).toEqual([
      { x: 117, y: 45 },
      { x: 157, y: 20 },
    ])
    expect(interpolate(items, 0.3, 'horizontal')[0]).toEqual({ x: 114, y: 40 })
    expect(interpolate(items, 1, 'horizontal')).toEqual([
      { x: 100, y: 40 },
      { x: 140, y: 20 },
    ])
  })
  it('never turns missing points into zeros or interpolated traffic', () => {
    const interpolate = interpolateActivitySamples(1000)
    const items = [
      {
        status: 'matched' as const,
        prev: { x: 10, y: 80 },
        next: { x: 0, y: null },
      },
      {
        status: 'matched' as const,
        prev: { x: 20, y: null },
        next: { x: 10, y: 40 },
      },
      { status: 'added' as const, next: { x: 30, y: null } },
      { status: 'removed' as const, prev: { x: -10, y: 50 } },
    ]
    expect(
      interpolate(items, 0.5, 'horizontal').map((point) => point.y)
    ).toEqual([null, 40, null])
  })
  it('skips initial entry and animates a normal live sampling cadence', () => {
    const { result, rerender } = renderHook(
      ({ time, following }) =>
        useActivityChartMotion(time, 'session', following),
      { initialProps: { time: 1000, following: true } }
    )
    expect(result.current.active).toBe(false)
    rerender({ time: 2000, following: true })
    expect(result.current.active).toBe(true)
    expect(result.current.duration).toBe(1000)
    rerender({ time: 3000, following: false })
    expect(result.current.active).toBe(false)
    rerender({ time: 3000, following: true })
    expect(result.current.active).toBe(false)
    rerender({ time: 15000, following: true })
    expect(result.current.active).toBe(false)
  })
  it('stops movement when reduced motion is enabled or the document is hidden', () => {
    const { result, rerender } = renderHook(
      ({ time }) => useActivityChartMotion(time, 'session', true),
      { initialProps: { time: 1000 } }
    )
    rerender({ time: 2000 })
    expect(result.current.active).toBe(true)
    act(() => setAppReduceMotion(true))
    expect(result.current.active).toBe(false)
    act(() => setAppReduceMotion(false))
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    rerender({ time: 3000 })
    expect(result.current.active).toBe(false)
  })
})
