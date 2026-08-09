import { DEFAULT_LOCALE } from '@shared/constants/locales'
import { afterEach, describe, expect, it } from 'vitest'
import { AppCapabilityHost } from './app'

const originalLang = process.env.LANG

afterEach(() => {
  if (originalLang === undefined) delete process.env.LANG
  else process.env.LANG = originalLang
})

describe('AppCapabilityHost locale', () => {
  it('resolves platform locale syntax through the shared catalog', () => {
    process.env.LANG = 'zh_CN.UTF-8'

    const snapshot = new AppCapabilityHost({
      appVersion: '2.0.0',
      runtime: 'server',
    }).snapshot()

    expect(snapshot.locale).toBe('zh-CN')
  })

  it('uses the shared default for unsupported environment locales', () => {
    process.env.LANG = 'fr_FR.UTF-8'

    const snapshot = new AppCapabilityHost({
      appVersion: '2.0.0',
      runtime: 'server',
    }).snapshot()

    expect(snapshot.locale).toBe(DEFAULT_LOCALE)
  })
})
