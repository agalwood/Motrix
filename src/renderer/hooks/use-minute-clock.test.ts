import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetMinuteClockForTests, useMinuteClock } from './use-minute-clock'

describe('useMinuteClock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-27T08:12:30.000Z'))
    __resetMinuteClockForTests()
  })

  afterEach(() => {
    __resetMinuteClockForTests()
    vi.useRealTimers()
  })

  it('updates on the next minute boundary and then once per minute', () => {
    const { result } = renderHook(() => useMinuteClock())
    const initial = result.current

    act(() => vi.advanceTimersByTime(29_999))
    expect(result.current).toBe(initial)

    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe(initial + 30_000)

    act(() => vi.advanceTimersByTime(60_000))
    expect(result.current).toBe(initial + 90_000)
  })

  it('shares one clock value between subscribers', () => {
    const first = renderHook(() => useMinuteClock())
    const second = renderHook(() => useMinuteClock())

    act(() => vi.advanceTimersByTime(30_000))

    expect(first.result.current).toBe(second.result.current)
  })
})
