import { describe, expect, it } from 'vitest'
import { isCjkLocale } from './locale-script'

describe('isCjkLocale', () => {
  it.each(['zh-CN', 'zh-TW', 'ja-JP', 'ko-KR'])(
    'recognizes the script used by %s',
    (locale) => {
      expect(isCjkLocale(locale)).toBe(true)
    }
  )

  it.each(['en-US', 'fr-FR', 'ar-SA', 'not-a-locale'])(
    'does not classify %s as CJK',
    (locale) => {
      expect(isCjkLocale(locale)).toBe(false)
    }
  )
})
