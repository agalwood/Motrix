import '@testing-library/jest-dom/vitest'
import { setAppReduceMotion } from '@renderer/lib/reduced-motion'
import type { SpeedPoint } from '@shared/types/stats'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SpeedSparkline } from './speed-sparkline'

const STEP = 1_000 / 23
const history = Array.from({ length: 200 }, (_, index) => ({
  t: index * 1_000,
  up: 20 + (index % 5) * 10,
  down: 40 + (index % 7) * 20,
}))

function append(points: readonly SpeedPoint[], speed = 100, elapsed = 1_000) {
  return [
    ...points.slice(1),
    { t: (points.at(-1)?.t ?? 0) + elapsed, up: speed, down: speed },
  ]
}

function chart(points: readonly SpeedPoint[], ceiling = 200, pointCount = 24) {
  return (
    <SpeedSparkline
      history={points}
      kind="down"
      ceiling={ceiling}
      pointCount={pointCount}
    />
  )
}

function offset(container: HTMLElement) {
  return Number(
    container
      .querySelector('[data-slot="speed-motion"]')
      ?.getAttribute('transform')
      ?.match(/^translate\(([^ ]+)/)?.[1]
  )
}

function scale(container: HTMLElement) {
  return Number(
    container
      .querySelector('[data-slot="speed-motion"]')
      ?.getAttribute('transform')
      ?.match(/scale\(1 ([^)]+)/)?.[1]
  )
}

function path(container: HTMLElement) {
  return (
    container.querySelector('[data-slot="speed-curve"]')?.getAttribute('d') ??
    ''
  )
}

describe('SpeedSparkline streaming', () => {
  let now = 0
  let nextFrame = 0
  let frames: Map<number, FrameRequestCallback>

  const advance = (ms: number) => {
    now += ms
    act(() => {
      const callbacks = [...frames.values()]
      frames.clear()
      for (const callback of callbacks) callback(now)
    })
  }

  beforeEach(() => {
    now = 0
    nextFrame = 0
    frames = new Map()
    setAppReduceMotion(false)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback)
      return nextFrame
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  })

  afterEach(() => {
    cleanup()
    setAppReduceMotion(false)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('shows the initial snapshot immediately without an entrance animation', () => {
    const { container } = render(chart(history))
    expect(offset(container)).toBe(0)
    expect(path(container).split('L')).toHaveLength(24)
    expect(frames.size).toBe(0)
  })

  it('moves existing vertices left at a constant speed while revealing the new sample', () => {
    const { container, rerender } = render(chart(history))
    const oldVertices = path(container)
      .slice(1)
      .split('L')
      .map((point) => point.split(',').map(Number))
    advance(1_000)
    rerender(chart(append(history)))
    const newPath = path(container)
    const newVertices = newPath
      .slice(1)
      .split('L')
      .map((point) => point.split(',').map(Number))

    expect(offset(container)).toBeCloseTo(STEP)
    for (let index = 0; index < oldVertices.length; index++) {
      expect(newVertices[index][0] + offset(container)).toBeCloseTo(
        oldVertices[index][0]
      )
      expect(newVertices[index][1]).toBe(oldVertices[index][1])
    }
    advance(250)
    expect(offset(container)).toBeCloseTo(STEP * 0.75)
    advance(250)
    expect(offset(container)).toBeCloseTo(STEP * 0.5)
    expect(path(container)).toBe(newPath)
    advance(500)
    expect(offset(container)).toBe(0)
    expect(frames.size).toBe(0)
  })

  it('continues from the displayed position when another sample arrives mid-slide', () => {
    const { container, rerender } = render(chart(history))
    const next = append(history)
    rerender(chart(next))
    advance(400)
    const before = offset(container)
    rerender(chart(append(next, 80)))
    expect(offset(container) - STEP).toBeCloseTo(before)
    expect(frames.size).toBe(1)
  })

  it('keeps early histories at a fixed spacing as the window fills', () => {
    const short = history.slice(-3)
    const { container, rerender } = render(chart(short))
    rerender(chart([...short, { t: 200_000, up: 100, down: 100 }]))
    expect(offset(container)).toBeCloseTo(STEP)
    expect(path(container).split('L')).toHaveLength(25)
  })

  it('preserves the displayed scale when a peak changes, then settles without overshoot', () => {
    const { container, rerender } = render(chart(history))
    const next = append(history, 800)
    rerender(chart(next, 1_000))
    expect(scale(container)).toBe(5)
    advance(150)
    expect(scale(container)).toBeGreaterThan(1)
    expect(scale(container)).toBeLessThan(5)
    advance(150)
    expect(scale(container)).toBe(1)
  })

  it('snaps replacement histories, long suspensions, and resized windows to their current state', () => {
    const { container, rerender } = render(chart(history))
    rerender(chart(append(history)))
    advance(200)
    rerender(chart(append(history, 100, 60_000)))
    expect(offset(container)).toBe(0)
    expect(frames.size).toBe(0)
    rerender(chart(history.slice(0, 10)))
    expect(offset(container)).toBe(0)
    rerender(chart(history, 200, 48))
    expect(offset(container)).toBe(0)
    expect(path(container).split('L')).toHaveLength(48)
  })

  it('renders idle history without scheduling invisible animation frames', () => {
    const idle = history.map((point) => ({ ...point, up: 0, down: 0 }))
    const { container, rerender } = render(chart(idle, 1))
    rerender(chart(append(idle, 0), 1))
    expect(offset(container)).toBe(0)
    expect(frames.size).toBe(0)
  })

  it('keeps moving after the speed reaches zero until the last activity leaves the window', () => {
    const { container, rerender } = render(chart(history))
    let samples = history
    for (let second = 1; second <= 24; second++) {
      samples = append(samples, 0)
      rerender(chart(samples))
      expect(offset(container)).toBeCloseTo(STEP)
      advance(500)
      expect(offset(container)).toBeCloseTo(STEP / 2)
      advance(500)
      expect(offset(container)).toBe(0)
    }
    samples = append(samples, 0)
    rerender(chart(samples))
    expect(offset(container)).toBe(0)
    expect(frames.size).toBe(0)
  })

  it('stops immediately when reduced motion is enabled and still accepts new data', () => {
    const { container, rerender } = render(chart(history))
    const next = append(history)
    rerender(chart(next))
    advance(200)
    act(() => setAppReduceMotion(true))
    expect(offset(container)).toBe(0)
    expect(frames.size).toBe(0)
    const before = path(container)
    rerender(chart(append(next, 150)))
    expect(path(container)).not.toBe(before)
    expect(offset(container)).toBe(0)
    expect(frames.size).toBe(0)
  })

  it('finishes when hidden and cancels pending work when unmounted', () => {
    const { container, rerender, unmount } = render(chart(history))
    const next = append(history)
    rerender(chart(next))
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(offset(container)).toBe(0)
    expect(frames.size).toBe(0)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    rerender(chart(append(next)))
    expect(frames.size).toBe(1)
    unmount()
    expect(frames.size).toBe(0)
  })
})
