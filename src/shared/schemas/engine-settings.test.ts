import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ENGINE_SETTINGS,
  engineSettingsSchema,
} from './engine-settings'

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
