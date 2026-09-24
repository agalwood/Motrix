import { describe, expect, it } from 'vitest'
import { trackerSettingsSchema } from './validators'

describe('trackerSettingsSchema', () => {
  it('provides defaults for empty input', () => {
    const result = trackerSettingsSchema.parse({})
    expect(result.autoSync).toBe(true)
    expect(result.syncIntervalHours).toBe(12)
    expect(result.probeEnabled).toBe(true)
    expect(result.probeTimeoutMs).toBe(5000)
    expect(result.healthyThresholdMs).toBe(3000)
    expect(result.minSuccessRate).toBe(0.5)
    expect(result.maxTrackerCount).toBe(50)
    expect(result.blacklistEnabled).toBe(true)
    expect(result.sources.length).toBeGreaterThan(0)
    expect(result.blacklistSources.length).toBeGreaterThan(0)
  })

  it('clamps syncIntervalHours to valid range', () => {
    const result = trackerSettingsSchema.parse({ syncIntervalHours: 0 })
    expect(result.syncIntervalHours).toBe(1)
  })

  it('includes distinct anime direct and CDN sources, both disabled by default', () => {
    const sources = trackerSettingsSchema.parse({}).sources
    expect(sources).toHaveLength(6)
    expect(new Set(sources.map((source) => source.id)).size).toBe(6)
    expect(new Set(sources.map((source) => source.url)).size).toBe(6)
    expect(sources.find((source) => source.id === 'anime-best')).toMatchObject({
      url: 'https://raw.githubusercontent.com/DeSireFire/animeTrackerList/master/AT_best.txt',
      builtin: true,
      enabled: false,
      cdn: false,
    })
    expect(
      sources.find((source) => source.id === 'anime-best-cdn')
    ).toMatchObject({
      url: 'https://cdn.jsdelivr.net/gh/DeSireFire/animeTrackerList/AT_best.txt',
      builtin: true,
      enabled: false,
      cdn: true,
    })
    expect(
      sources.filter((source) => source.enabled).map((source) => source.id)
    ).toEqual(['ngosang-best', 'xiu2-best'])
  })

  it('includes both enabled CDN blacklist sources in fresh defaults', () => {
    const sources = trackerSettingsSchema.parse({}).blacklistSources
    expect(sources.map((source) => source.id)).toEqual([
      'xiu2-blacklist',
      'anime-bad',
    ])
    expect(
      sources.every((source) => source.builtin && source.enabled && source.cdn)
    ).toBe(true)
    expect(sources.find((source) => source.id === 'anime-bad')?.url).toBe(
      'https://cdn.jsdelivr.net/gh/DeSireFire/animeTrackerList/AT_bad.txt'
    )
  })

  it('clamps maxTrackerCount to valid range', () => {
    const result = trackerSettingsSchema.parse({ maxTrackerCount: 999 })
    expect(result.maxTrackerCount).toBe(200)
  })

  it('falls back to defaults for invalid types', () => {
    const result = trackerSettingsSchema.parse({
      autoSync: 'not a boolean',
      probeTimeoutMs: 'not a number',
    })
    expect(result.autoSync).toBe(true)
    expect(result.probeTimeoutMs).toBe(5000)
  })

  it('defaults sourcesEnabled to true', () => {
    const result = trackerSettingsSchema.parse({})
    expect(result.sourcesEnabled).toBe(true)
  })

  it('accepts explicit sourcesEnabled = false', () => {
    const result = trackerSettingsSchema.parse({ sourcesEnabled: false })
    expect(result.sourcesEnabled).toBe(false)
  })
})
