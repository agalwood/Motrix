import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ENGINE_SETTINGS,
  engineSettingsInputSchema,
  engineSettingsSchema,
} from './engine-settings'
import {
  DEFAULT_SPEED_LIMIT_SETTINGS,
  speedLimitSettingsInputSchema,
  speedLimitSettingsSchema,
} from './speed-limit'

describe('settings input validation', () => {
  it('defaults concurrent downloads to 10 and preserves an existing user value', () => {
    expect(DEFAULT_ENGINE_SETTINGS.maxConcurrentDownloads).toBe(10)
    expect(
      engineSettingsSchema.parse({ maxConcurrentDownloads: 5 })
        .maxConcurrentDownloads
    ).toBe(5)
  })

  it('rejects invalid input before defaults or performance presets can replace it', () => {
    const input = { ...DEFAULT_ENGINE_SETTINGS, split: 1000 }
    expect(engineSettingsInputSchema.safeParse(input).success).toBe(false)
    expect(engineSettingsSchema.parse(input).split).toBe(
      DEFAULT_ENGINE_SETTINGS.split
    )
  })

  it('enforces aria2 minimum segment size bounds while allowing whole-byte fractions of MiB', () => {
    const schema = engineSettingsInputSchema.shape.minSplitSize
    for (const value of [1048576, 1.5 * 1048576, 1073741824]) {
      expect(schema.safeParse(value).success).toBe(true)
    }
    for (const value of [1048575, 1073741825, 1048576.5, NaN, Infinity]) {
      expect(schema.safeParse(value).success).toBe(false)
    }
  })

  it('rejects nested speed settings without recovering the entire group', () => {
    const input = structuredClone(DEFAULT_SPEED_LIMIT_SETTINGS)
    input.base.download = -1
    input.auto.adaptive.headroomPercent = 101
    input.auto.adaptive.speedTest.concurrency = 1000
    const result = speedLimitSettingsInputSchema.safeParse(input)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual([
      'base.download',
      'auto.adaptive.headroomPercent',
      'auto.adaptive.speedTest.concurrency',
    ])
    expect(speedLimitSettingsSchema.parse(input)).toEqual(
      DEFAULT_SPEED_LIMIT_SETTINGS
    )
  })

  it('rejects byte rates too large to represent safely', () => {
    const input = structuredClone(DEFAULT_SPEED_LIMIT_SETTINGS)
    input.base.download = 1e100
    expect(speedLimitSettingsInputSchema.safeParse(input).success).toBe(false)
  })
})
