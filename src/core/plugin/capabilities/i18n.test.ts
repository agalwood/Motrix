import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nCapabilityHost } from './i18n'

describe('I18nCapabilityHost', () => {
  let rootDir: string
  let localeDir: string

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), 'motrix-i18n-'))
    localeDir = path.join(rootDir, 'l10n')
    mkdirSync(localeDir)
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('returns an empty left-to-right snapshot when no locale directory is declared', async () => {
    const host = new I18nCapabilityHost({ hostLanguage: 'en-US' })

    await expect(host.snapshot(rootDir)).resolves.toEqual({
      language: 'en-US',
      dir: 'ltr',
      currentDict: {},
      fallbackDict: {},
    })
  })

  it('derives RTL direction even when no locale directory is declared', async () => {
    const host = new I18nCapabilityHost({ hostLanguage: 'ar-EG' })

    await expect(host.snapshot(rootDir)).resolves.toEqual({
      language: 'ar-EG',
      dir: 'rtl',
      currentDict: {},
      fallbackDict: {},
    })
  })

  it('loads fallback and current dictionaries into one flat key space', async () => {
    writeFileSync(
      path.join(localeDir, 'en-US.json'),
      JSON.stringify({ title: 'Fallback', nav: { open: 'Open' }, count: 2 })
    )
    writeFileSync(
      path.join(localeDir, 'zh-CN.json'),
      JSON.stringify({ title: '当前', nav: { open: '打开' } })
    )
    const host = new I18nCapabilityHost({ hostLanguage: 'zh-CN' })

    await expect(host.snapshot(rootDir, 'l10n')).resolves.toEqual({
      language: 'zh-CN',
      dir: 'ltr',
      currentDict: { title: '当前', 'nav.open': '打开' },
      fallbackDict: { title: 'Fallback', 'nav.open': 'Open' },
    })
  })

  it('uses an RTL direction and degrades missing current dictionaries to empty', async () => {
    writeFileSync(
      path.join(localeDir, 'en-US.json'),
      JSON.stringify({ title: 'Fallback' })
    )
    const host = new I18nCapabilityHost({ hostLanguage: 'ar-EG' })

    await expect(host.snapshot(rootDir, 'l10n')).resolves.toEqual({
      language: 'ar-EG',
      dir: 'rtl',
      currentDict: {},
      fallbackDict: { title: 'Fallback' },
    })
  })

  it('treats malformed dictionaries as unavailable', async () => {
    writeFileSync(path.join(localeDir, 'en-US.json'), '{bad json')
    writeFileSync(path.join(localeDir, 'fr.json'), 'null')
    const host = new I18nCapabilityHost({ hostLanguage: 'fr' })

    await expect(host.snapshot(rootDir, 'l10n')).resolves.toEqual({
      language: 'fr',
      dir: 'ltr',
      currentDict: {},
      fallbackDict: {},
    })
  })

  it('notifies subscribers of language changes and supports unsubscribe', () => {
    const host = new I18nCapabilityHost({ hostLanguage: 'en-US' })
    const listener = vi.fn()
    const unsubscribe = host.onChange(listener)

    host.setLanguage('he-IL')
    unsubscribe()
    host.setLanguage('fr')

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith('he-IL')
  })

  it('isolates a throwing listener and continues notifying subscribers', () => {
    const onListenerError = vi.fn()
    const host = new I18nCapabilityHost({
      hostLanguage: 'en-US',
      onListenerError,
    })
    const survivor = vi.fn()
    host.onChange(() => {
      throw new Error('broken locale listener')
    })
    host.onChange(survivor)

    expect(() => host.setLanguage('zh-CN')).not.toThrow()
    expect(host.language).toBe('zh-CN')
    expect(survivor).toHaveBeenCalledWith('zh-CN')
    expect(onListenerError).toHaveBeenCalledOnce()
  })
})
