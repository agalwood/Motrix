import { describe, expect, it } from 'vitest'
import {
  createDefaultSpeedLimitSettings,
  DEFAULT_SPEED_LIMIT_SETTINGS,
  speedLimitSettingsSchema,
} from './speed-limit'

describe('speedLimitSettingsSchema', () => {
  it.each([
    ['decimal', 64_000, 512_000],
    ['binary', 65_536, 524_288],
  ] as const)(
    'creates integer presets in %s display units',
    (units, upload, download) => {
      const settings = createDefaultSpeedLimitSettings(units)
      expect(settings.alt).toEqual({ upload, download })
      expect(settings.base).toEqual({ upload: 0, download: 0 })
      expect(settings.turtle).toBe('off')
      expect(settings.auto.schedule.enabled).toBe(false)
      expect(settings.auto.adaptive.enabled).toBe(false)
      settings.auto.schedule.days.push(1)
      expect(createDefaultSpeedLimitSettings(units).auto.schedule.days).toEqual(
        []
      )
      expect(DEFAULT_SPEED_LIMIT_SETTINGS.auto.schedule.days).toEqual([])
    }
  )

  it('DEFAULT_SPEED_LIMIT_SETTINGS has correct baseline values', () => {
    expect(DEFAULT_SPEED_LIMIT_SETTINGS.turtle).toBe('off')
    expect(DEFAULT_SPEED_LIMIT_SETTINGS.base).toEqual({
      download: 0,
      upload: 0,
    })
    expect(DEFAULT_SPEED_LIMIT_SETTINGS.alt).toEqual({
      download: 512 * 1024,
      upload: 64 * 1024,
    })
    expect(DEFAULT_SPEED_LIMIT_SETTINGS.auto.schedule).toMatchObject({
      enabled: false,
      from: '23:00',
      to: '07:00',
      days: [],
    })
    expect(DEFAULT_SPEED_LIMIT_SETTINGS.auto.adaptive.headroomPercent).toBe(80)
  })

  it('seeds the cloudflare + apple speed-test presets', () => {
    const ids =
      DEFAULT_SPEED_LIMIT_SETTINGS.auto.adaptive.speedTest.providers.map(
        (p) => p.id
      )
    expect(ids).toEqual(['cloudflare', 'apple'])
    const apple =
      DEFAULT_SPEED_LIMIT_SETTINGS.auto.adaptive.speedTest.providers.find(
        (p) => p.id === 'apple'
      )
    expect(apple?.upload).toBeNull()
  })

  it('clamps invalid values to defaults', () => {
    const parsed = speedLimitSettingsSchema.parse({
      turtle: 'bogus',
      auto: { adaptive: { headroomPercent: 999 } },
    })
    expect(parsed.turtle).toBe('off')
    expect(parsed.auto.adaptive.headroomPercent).toBe(80)
  })

  it('clamps below-min headroomPercent to default', () => {
    const parsed = speedLimitSettingsSchema.parse({
      auto: { adaptive: { headroomPercent: 0 } },
    })
    expect(parsed.auto.adaptive.headroomPercent).toBe(80)
  })

  it('rejects schedule times outside the 24-hour clock', () => {
    const parsed = speedLimitSettingsSchema.parse({
      auto: { schedule: { from: '24:00', to: '12:60' } },
    })
    expect(parsed.auto.schedule.from).toBe('23:00')
    expect(parsed.auto.schedule.to).toBe('07:00')
  })
})
