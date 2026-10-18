import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type {
  ActivityChartDomain,
  ActivityChartRange,
} from './activity-chart-model'
import { useActivityChartViewport } from './use-activity-chart-viewport'

function setup(range: ActivityChartRange = 'session') {
  return renderHook(
    ({
      domain,
      range,
    }: {
      domain: ActivityChartDomain
      range: ActivityChartRange
    }) => useActivityChartViewport(domain, range),
    { initialProps: { domain: [100000, 400000] as ActivityChartDomain, range } }
  )
}
describe('useActivityChartViewport', () => {
  it('opens on exactly 60 seconds and follows new samples', () => {
    const { result, rerender } = setup()
    expect(result.current.window).toEqual([340000, 400000])
    rerender({ domain: [100000, 410000], range: 'session' })
    expect(result.current.window).toEqual([350000, 410000])
  })
  it('freezes a historical window and resumes when panned back to the end', () => {
    const { result, rerender } = setup()
    act(() => result.current.pan(-60000))
    expect(result.current.following).toBe(false)
    rerender({ domain: [100000, 410000], range: 'session' })
    expect(result.current.window).toEqual([280000, 340000])
    act(() => result.current.pan(1000000))
    expect(result.current.following).toBe(true)
    rerender({ domain: [100000, 420000], range: 'session' })
    expect(result.current.window).toEqual([360000, 420000])
  })
  it('keeps the full overview expanding until zoomed and then preserves the zoom span', () => {
    const { result, rerender } = setup('lifetime')
    expect(result.current.window).toEqual([100000, 400000])
    rerender({ domain: [100000, 500000], range: 'lifetime' })
    expect(result.current.window).toEqual([100000, 500000])
    act(() => result.current.zoom(0.5))
    expect(result.current.window).toEqual([300000, 500000])
    rerender({ domain: [100000, 510000], range: 'lifetime' })
    expect(result.current.window).toEqual([310000, 510000])
  })
  it('holds a selected overview interval as samples arrive and can return to latest', () => {
    const { result, rerender } = setup('lifetime')
    act(() => result.current.select([150000, 200000]))
    rerender({ domain: [100000, 500000], range: 'lifetime' })
    expect(result.current.window).toEqual([150000, 200000])
    act(() => result.current.followLatest())
    expect(result.current.window).toEqual([450000, 500000])
    act(() => result.current.showAll())
    expect(result.current.window).toEqual([100000, 500000])
  })
  it('resets selection when changing ranges, including returning to the previous range', () => {
    const { result, rerender } = setup()
    act(() => result.current.pan(-60000))
    rerender({ domain: [100000, 400000], range: 'lifetime' })
    expect(result.current.window).toEqual([100000, 400000])
    rerender({ domain: [100000, 400000], range: 'session' })
    expect(result.current.window).toEqual([340000, 400000])
    expect(result.current.following).toBe(true)
  })
  it('clamps zoom and pan without producing a zero-width time axis', () => {
    const { result } = setup('lifetime')
    act(() => result.current.zoom(0.000001))
    expect(result.current.window).toEqual([399000, 400000])
    act(() => result.current.select([500000, 500000]))
    expect(result.current.window).toEqual([399000, 400000])
    act(() => result.current.zoom(1000000))
    expect(result.current.window).toEqual([100000, 400000])
  })
  it('shows an honest empty leading interval when fewer than 60 seconds are available', () => {
    const { result } = renderHook(() =>
      useActivityChartViewport([99000, 100000], 'session')
    )
    expect(result.current.window).toEqual([40000, 100000])
  })

  it('fits short lifetime history to its real duration instead of a 60-second window', () => {
    const { result } = renderHook(() =>
      useActivityChartViewport([1000, 2500], 'lifetime')
    )
    expect(result.current.window).toEqual([1000, 2500])
  })
})
