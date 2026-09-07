import { describe, expect, it } from 'vitest'
import { appSettingsSchema, DEFAULT_APP_SETTINGS } from './app-settings'

describe('appSettingsSchema', () => {
  it('keeps selection timeout downloads opt-in with a 60 second default', () => {
    expect(DEFAULT_APP_SETTINGS.magnetFileSelectionAutoDownload).toBe(false)
    expect(DEFAULT_APP_SETTINGS.magnetFileSelectionTimeoutSeconds).toBe(60)
    expect(
      appSettingsSchema.parse({ magnetFileSelectionAutoDownload: true })
        .magnetFileSelectionAutoDownload
    ).toBe(true)
  })

  it.each([0, -1, 9, 3601, 60.5, '60', null])(
    'recovers invalid selection timeout %s',
    (value) => {
      expect(
        appSettingsSchema.parse({ magnetFileSelectionTimeoutSeconds: value })
          .magnetFileSelectionTimeoutSeconds
      ).toBe(60)
    }
  )

  it.each([10, 120, 3600])('preserves valid selection timeout %s', (value) => {
    expect(
      appSettingsSchema.parse({ magnetFileSelectionTimeoutSeconds: value })
        .magnetFileSelectionTimeoutSeconds
    ).toBe(value)
  })

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
