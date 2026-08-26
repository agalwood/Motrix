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
