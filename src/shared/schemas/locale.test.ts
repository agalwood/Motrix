import { SUPPORTED_LOCALE_CODES } from '@shared/constants/locales'
import { describe, expect, it } from 'vitest'
import { supportedLocaleSchema } from './locale'

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
