import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CUBIC_GLASS_EFFECTS,
  GRADIENT_PRESETS,
  POINTER_POSITION_CONSTRAINT,
  POINTER_TRAVEL,
  resolveCubicGlassEffects,
} from './config'
import { MAX_GRADIENT_BLOBS, MAX_GRADIENT_ENVELOPES } from './shaders'
import type { CubicGlassGradientPreset } from './types'

const PRESETS: readonly CubicGlassGradientPreset[] = ['blue-pink', 'dual-wave']

describe('cubic glass config', () => {
  it.each(PRESETS)('keeps %s within the shader capacity', (preset) => {
    expect(GRADIENT_PRESETS[preset].blobs.length).toBeLessThanOrEqual(
      MAX_GRADIENT_BLOBS
    )
    expect(GRADIENT_PRESETS[preset].envelopes.length).toBeLessThanOrEqual(
      MAX_GRADIENT_ENVELOPES
    )
    expect(POINTER_TRAVEL[preset]).toHaveLength(2)
    expect(POINTER_POSITION_CONSTRAINT[preset]).toEqual(
      expect.objectContaining({
        downward: expect.any(Number),
        upward: expect.any(Number),
        verticalPower: expect.any(Number),
      })
    )
  })

  it('normalizes invalid public speed values', () => {
    expect(
      resolveCubicGlassEffects({ horizontalSpeed: -1 }).horizontalSpeed
    ).toBe(0)
    expect(
      resolveCubicGlassEffects({ horizontalSpeed: 101 }).horizontalSpeed
    ).toBe(100)
    expect(
      resolveCubicGlassEffects({ horizontalSpeed: Number.NaN }).horizontalSpeed
    ).toBe(DEFAULT_CUBIC_GLASS_EFFECTS.horizontalSpeed)
  })
})
