import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getLocale } = vi.hoisted(() => ({
  getLocale: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getLocale },
}))

import { resolvePluginHostLanguage } from './host-language'

describe('resolvePluginHostLanguage', () => {
  beforeEach(() => {
    getLocale.mockReset()
    getLocale.mockReturnValue('en-US')
  })

  it('uses the persisted supported locale before the system locale', () => {
    expect(resolvePluginHostLanguage('zh-CN')).toBe('zh-CN')
  })

  it('resolves legacy sentinels and canonicalizes the system locale', () => {
    getLocale.mockReturnValue('zh_Hans_CN')

    expect(resolvePluginHostLanguage('system')).toBe('zh-CN')
  })

  it('falls back through the shared catalog for unsupported candidates', () => {
    getLocale.mockReturnValue('fr-FR')

    expect(resolvePluginHostLanguage('invalid')).toBe('en-US')
  })
})
