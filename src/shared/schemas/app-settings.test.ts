import { describe, expect, it } from 'vitest'
import {
  appSettingsInputSchema,
  appSettingsSchema,
  DEFAULT_APP_SETTINGS,
} from './app-settings'

describe('appSettingsSchema', () => {
  it('preserves existing notification defaults, loads desktop choices, and rejects malformed writes', () => {
    const defaults = {
      notifyInAppOnComplete: true,
      notifyInAppOnError: true,
      notificationBadgeStyle: 'count',
    }
    expect(appSettingsSchema.parse({})).toMatchObject(defaults)
    expect(
      appSettingsSchema.parse({
        notifyInAppOnComplete: 'false',
        notifyInAppOnError: null,
        notificationBadgeStyle: 'off',
      })
    ).toMatchObject(defaults)
    for (const notificationBadgeStyle of ['count', 'dot', 'hidden']) {
      const choices = {
        notifyInAppOnComplete: false,
        notifyInAppOnError: false,
        notificationBadgeStyle,
      }
      expect(appSettingsSchema.parse(choices)).toMatchObject(choices)
      expect(appSettingsInputSchema.partial().safeParse(choices).success).toBe(
        true
      )
    }
    for (const invalid of [
      { notifyInAppOnComplete: 'false' },
      { notifyInAppOnError: null },
      { notificationBadgeStyle: 'off' },
    ]) {
      expect(appSettingsInputSchema.partial().safeParse(invalid).success).toBe(
        false
      )
    }
  })
  it('defaults existing and invalid file deletion preferences to trash', () => {
    expect(DEFAULT_APP_SETTINGS.fileDeletionMode).toBe('trash')
    for (const fileDeletionMode of [undefined, null, 'delete', false]) {
      expect(
        appSettingsSchema.parse({ fileDeletionMode }).fileDeletionMode
      ).toBe('trash')
    }
    for (const fileDeletionMode of ['trash', 'permanent']) {
      expect(
        appSettingsSchema.parse({ fileDeletionMode }).fileDeletionMode
      ).toBe(fileDeletionMode)
    }
    expect(
      appSettingsInputSchema.partial().safeParse({ fileDeletionMode: 'delete' })
        .success
    ).toBe(false)
  })
  it('defaults old or invalid tray colors to auto without resetting valid preferences', () => {
    expect(DEFAULT_APP_SETTINGS.trayIconColor).toBe('auto')
    for (const trayIconColor of [undefined, null, 'white', true]) {
      expect(appSettingsSchema.parse({ trayIconColor }).trayIconColor).toBe(
        'auto'
      )
    }
    for (const trayIconColor of ['auto', 'light', 'dark']) {
      expect(appSettingsSchema.parse({ trayIconColor }).trayIconColor).toBe(
        trayIconColor
      )
    }
    expect(
      appSettingsInputSchema.partial().safeParse({ trayIconColor: 'white' })
        .success
    ).toBe(false)
  })
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

it('keeps login launches hidden for existing and invalid settings', () => {
  for (const value of [undefined, null, 'true', false]) {
    expect(
      appSettingsSchema.parse({ showMainWindowAtLogin: value })
        .showMainWindowAtLogin
    ).toBe(false)
  }
  expect(
    appSettingsSchema.parse({ showMainWindowAtLogin: true })
      .showMainWindowAtLogin
  ).toBe(true)
})

it('defaults byte units for old settings and preserves explicit choices', () => {
  expect(DEFAULT_APP_SETTINGS.byteUnitSystem).toBe('system')
  for (const byteUnitSystem of [undefined, null, 'MB', 1024]) {
    expect(appSettingsSchema.parse({ byteUnitSystem }).byteUnitSystem).toBe(
      'system'
    )
  }
  for (const byteUnitSystem of ['system', 'decimal', 'binary']) {
    expect(appSettingsSchema.parse({ byteUnitSystem }).byteUnitSystem).toBe(
      byteUnitSystem
    )
  }
})
