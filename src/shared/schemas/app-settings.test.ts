import { describe, expect, it } from 'vitest'
import { appSettingsSchema, DEFAULT_APP_SETTINGS } from './app-settings'

describe('appSettingsSchema', () => {
  it('defaults reduceMotion to false and preserves an explicit opt-in', () => {
    expect(DEFAULT_APP_SETTINGS.reduceMotion).toBe(false)
    expect(appSettingsSchema.parse({}).reduceMotion).toBe(false)
    expect(appSettingsSchema.parse({ reduceMotion: true }).reduceMotion).toBe(
      true
    )
    expect(appSettingsSchema.parse({ reduceMotion: 'yes' }).reduceMotion).toBe(
      false
    )
  })

  it('defaults traySpeedometer to true while preserving an explicit opt-out', () => {
    expect(DEFAULT_APP_SETTINGS.traySpeedometer).toBe(true)
    expect(appSettingsSchema.parse({}).traySpeedometer).toBe(true)
    expect(
      appSettingsSchema.parse({ traySpeedometer: false }).traySpeedometer
    ).toBe(false)
  })

  it('defaults lightweightMode to false', () => {
    expect(DEFAULT_APP_SETTINGS.lightweightMode).toBe(false)
    expect(appSettingsSchema.parse({}).lightweightMode).toBe(false)
  })

  it('recovers from an invalid lightweightMode value', () => {
    expect(
      appSettingsSchema.parse({ lightweightMode: 'yes' }).lightweightMode
    ).toBe(false)
  })

  it('defaults autofillClipboardLinks to true', () => {
    expect(DEFAULT_APP_SETTINGS.autofillClipboardLinks).toBe(true)
    expect(appSettingsSchema.parse({}).autofillClipboardLinks).toBe(true)
  })

  it('recovers from an invalid autofillClipboardLinks value', () => {
    expect(
      appSettingsSchema.parse({ autofillClipboardLinks: 'nope' })
        .autofillClipboardLinks
    ).toBe(true)
  })
})
