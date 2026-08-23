import { describe, expect, it } from 'vitest'
import { ENGINE_PERFORMANCE_PROFILES } from '../constants/engine-performance-profiles'
import {
  DEFAULT_ENGINE_SETTINGS,
  engineSettingsSchema,
  MAX_CONNECTIONS_PER_SERVER,
} from './engine-settings'

describe('engineSettingsSchema maxConnectionPerServer', () => {
  it('defaults to the Motrix aria2 connection limit', () => {
    expect(DEFAULT_ENGINE_SETTINGS.maxConnectionPerServer).toBe(
      MAX_CONNECTIONS_PER_SERVER
    )
  })

  it('accepts the maximum supported Motrix value', () => {
    expect(
      engineSettingsSchema.parse({
        maxConnectionPerServer: MAX_CONNECTIONS_PER_SERVER,
      }).maxConnectionPerServer
    ).toBe(MAX_CONNECTIONS_PER_SERVER)
  })

  it('recovers values above the Motrix limit to the default', () => {
    expect(
      engineSettingsSchema.parse({
        maxConnectionPerServer: MAX_CONNECTIONS_PER_SERVER + 1,
      }).maxConnectionPerServer
    ).toBe(MAX_CONNECTIONS_PER_SERVER)
  })
})

describe('engineSettingsSchema performance profiles', () => {
  it('uses automatic performance tuning by default', () => {
    expect(DEFAULT_ENGINE_SETTINGS).toMatchObject({
      performanceProfile: 'auto',
      ...ENGINE_PERFORMANCE_PROFILES.auto,
    })
  })

  it.each(['balanced', 'high', 'maximum'] as const)(
    'links every tuning value for the %s profile',
    (performanceProfile) => {
      expect(engineSettingsSchema.parse({ performanceProfile })).toMatchObject({
        performanceProfile,
        ...ENGINE_PERFORMANCE_PROFILES[performanceProfile],
      })
    }
  )

  it('preserves individual values in the custom profile', () => {
    expect(
      engineSettingsSchema.parse({
        performanceProfile: 'custom',
        maxConnectionPerServer: 24,
        split: 12,
        minSplitSize: 2 * 1024 * 1024,
        diskCache: 48 * 1024 * 1024,
      })
    ).toMatchObject({
      performanceProfile: 'custom',
      maxConnectionPerServer: 24,
      split: 12,
      minSplitSize: 2 * 1024 * 1024,
      diskCache: 48 * 1024 * 1024,
    })
  })
})

describe('engineSettingsSchema dnsMode', () => {
  it('defaults to auto', () => {
    expect(DEFAULT_ENGINE_SETTINGS.dnsMode).toBe('auto')
  })

  it.each(['auto', 'system', 'engine'] as const)('accepts %s', (mode) => {
    expect(engineSettingsSchema.parse({ dnsMode: mode }).dnsMode).toBe(mode)
  })

  it.each(['c-ares', 'true', 42, null])(
    'recovers invalid persisted value %s to auto',
    (bad) => {
      expect(engineSettingsSchema.parse({ dnsMode: bad }).dnsMode).toBe('auto')
    }
  )
})

describe('engineSettingsSchema remoteTime', () => {
  it('uses the local modification time by default', () => {
    expect(DEFAULT_ENGINE_SETTINGS.remoteTime).toBe(false)
  })

  it.each([true, false])('accepts %s', (remoteTime) => {
    expect(engineSettingsSchema.parse({ remoteTime }).remoteTime).toBe(
      remoteTime
    )
  })

  it.each(['server', 1, null])(
    'recovers invalid persisted value %s to false',
    (bad) => {
      expect(engineSettingsSchema.parse({ remoteTime: bad }).remoteTime).toBe(
        false
      )
    }
  )
})
