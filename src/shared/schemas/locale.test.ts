import { SUPPORTED_LOCALE_CODES } from '@shared/constants/locales'
import { describe, expect, it } from 'vitest'
import { languagePreferenceSchema, supportedLocaleSchema } from './locale'

describe('supportedLocaleSchema', () => {
  it.each(SUPPORTED_LOCALE_CODES)(
    'accepts the registered locale %s',
    (locale) => {
      expect(supportedLocaleSchema.parse(locale)).toBe(locale)
    }
  )

  it.each(['fr-FR', 'zh_cn', 'auto', ''])('rejects %s', (locale) => {
    expect(supportedLocaleSchema.safeParse(locale).success).toBe(false)
  })
})

it('accepts system only as a language preference, never a resolved locale', () => {
  expect(languagePreferenceSchema.parse('system')).toBe('system')
  expect(supportedLocaleSchema.safeParse('system').success).toBe(false)
  expect(languagePreferenceSchema.safeParse('auto').success).toBe(false)
})
