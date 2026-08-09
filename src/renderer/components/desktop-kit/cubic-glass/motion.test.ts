import { describe, expect, it } from 'vitest'
import {
  isSpringSettled,
  resolveHorizontalResponseSeconds,
  resolvePointerOffset,
  type SpringAxisState,
  stepCriticalSpring,
} from './motion'

describe('cubic glass motion', () => {
  it('maps speed control values to a bounded spring response', () => {
    expect(resolveHorizontalResponseSeconds(0)).toBe(5.5)
    expect(resolveHorizontalResponseSeconds(45)).toBe(3.25)
    expect(resolveHorizontalResponseSeconds(50)).toBe(3)
    expect(resolveHorizontalResponseSeconds(100)).toBe(0.5)
    expect(resolveHorizontalResponseSeconds(-20)).toBe(5.5)
    expect(resolveHorizontalResponseSeconds(120)).toBe(0.5)
  })

  it('maps pointer coordinates with an optional gravity constraint', () => {
    const bounds = { left: 20, top: 40, width: 200, height: 100 }
    const travel = { x: 0.4, y: 0.22 }
    const gravity = { upward: 0.045, downward: 0.018, verticalPower: 1.35 }

    expect(resolvePointerOffset(120, 90, bounds, travel)).toEqual({
      x: 0,
      y: 0,
    })
    expect(resolvePointerOffset(220, 40, bounds, travel, gravity)).toEqual({
      x: 0.4,
      y: 0.045,
    })
    expect(resolvePointerOffset(220, 40, bounds, travel)).toEqual({
      x: 0.4,
      y: 0.22,
    })
    expect(resolvePointerOffset(120, 140, bounds, travel, gravity)).toEqual({
      x: 0,
      y: -0.018,
    })
  })

  it('follows and returns with an interruptible critically damped spring', () => {
    let state: SpringAxisState = { value: 0, velocity: 0 }
    for (let frame = 0; frame < 30; frame += 1) {
      const previous = state.value
      state = stepCriticalSpring(state, 0.05, 0.72, 1 / 60)
      expect(state.value).toBeGreaterThanOrEqual(previous)
      expect(state.value).toBeLessThanOrEqual(0.05)
    }
    expect(state.value).toBeGreaterThan(0.045)

    const valueAtRetarget = state.value
    state = stepCriticalSpring(state, 0, 0.9, 1 / 60)
    expect(Math.abs(state.value - valueAtRetarget)).toBeLessThan(0.001)
    for (let frame = 0; frame < 180; frame += 1) {
      state = stepCriticalSpring(state, 0, 0.9, 1 / 60)
    }
    expect(isSpringSettled(state, 0)).toBe(true)
  })

  it('clamps long frame gaps to a stable integration step', () => {
    const state = { value: 0.02, velocity: 0.15 }
    expect(stepCriticalSpring(state, 0.05, 0.72, 4)).toEqual(
      stepCriticalSpring(state, 0.05, 0.72, 0.05)
    )
  })
})
