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
    getLocale.mockReturnValue('qaa')

    expect(resolvePluginHostLanguage('invalid')).toBe('en-US')
  })

  it('uses bundled French for a French system locale', () => {
    getLocale.mockReturnValue('fr-FR')

    expect(resolvePluginHostLanguage('system')).toBe('fr')
  })

  it('uses bundled German for a German system locale', () => {
    getLocale.mockReturnValue('de-DE')

    expect(resolvePluginHostLanguage('system')).toBe('de')
    expect(resolvePluginHostLanguage('en-US')).toBe('en-US')
  })

  it('uses bundled Spanish for a Spanish system locale', () => {
    getLocale.mockReturnValue('es-ES')

    expect(resolvePluginHostLanguage('system')).toBe('es')
    expect(resolvePluginHostLanguage('en-US')).toBe('en-US')
  })

  it('uses bundled Korean for a Korean system locale', () => {
    getLocale.mockReturnValue('ko-KR')

    expect(resolvePluginHostLanguage('system')).toBe('ko')
    expect(resolvePluginHostLanguage('en-US')).toBe('en-US')
  })

  it('uses bundled Japanese for a Japanese system locale', () => {
    getLocale.mockReturnValue('ja-JP')

    expect(resolvePluginHostLanguage('system')).toBe('ja')
    expect(resolvePluginHostLanguage('en-US')).toBe('en-US')
  })

  it('uses Brazilian Portuguese for the system while honoring explicit English', () => {
    getLocale.mockReturnValue('pt-BR')

    expect(resolvePluginHostLanguage('system')).toBe('pt-BR')
    expect(resolvePluginHostLanguage('en-US')).toBe('en-US')
  })

  it('uses Indonesian for the system while honoring explicit English', () => {
    getLocale.mockReturnValue('id-ID')

    expect(resolvePluginHostLanguage('system')).toBe('id')
    expect(resolvePluginHostLanguage('en-US')).toBe('en-US')
  })

  it('uses Italian for the system while honoring explicit English', () => {
    getLocale.mockReturnValue('it-IT')

    expect(resolvePluginHostLanguage('system')).toBe('it')
    expect(resolvePluginHostLanguage('en-US')).toBe('en-US')
  })

  it('uses Russian for the system while honoring explicit English', () => {
    getLocale.mockReturnValue('ru-RU')

    expect(resolvePluginHostLanguage('system')).toBe('ru')
    expect(resolvePluginHostLanguage('en-US')).toBe('en-US')
  })

  it('uses Turkish for the system while honoring explicit English', () => {
    getLocale.mockReturnValue('tr-TR')

    expect(resolvePluginHostLanguage('system')).toBe('tr')
    expect(resolvePluginHostLanguage('en-US')).toBe('en-US')
  })

  it('uses Vietnamese for the system while honoring explicit English', () => {
    getLocale.mockReturnValue('vi-VN')

    expect(resolvePluginHostLanguage('system')).toBe('vi')
    expect(resolvePluginHostLanguage('en-US')).toBe('en-US')
  })

  it('uses Polish for the system while honoring explicit English', () => {
    getLocale.mockReturnValue('pl-PL')

    expect(resolvePluginHostLanguage('system')).toBe('pl')
    expect(resolvePluginHostLanguage('en-US')).toBe('en-US')
  })
})
