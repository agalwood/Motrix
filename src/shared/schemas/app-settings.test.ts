import { describe, expect, it } from 'vitest'
import { appSettingsSchema, DEFAULT_APP_SETTINGS } from './app-settings'

describe('appSettingsSchema', () => {
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
