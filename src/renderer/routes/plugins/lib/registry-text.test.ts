import type { RegistryPluginDTO } from '@shared/schemas/registry'
import { describe, expect, it } from 'vitest'
import {
  matchesRegistrySearch,
  registryListing,
  registrySearchText,
} from './registry-text'

function entry(): RegistryPluginDTO {
  return {
    id: 'example.archive-unpacker',
    listing: {
      defaultLocale: 'en-US',
      localizations: {
        'en-US': {
          name: 'Archive Unpacker',
          description: 'Extracts downloads',
          features: ['Default feature'],
          keywords: ['archive'],
        },
        'zh-CN': {
          name: '简体解压器',
          description: '简体说明',
          keywords: ['压缩包'],
        },
        'zh-Hant': { description: '繁體說明', features: [] },
        'ja-JP': { name: 'アーカイブ展開' },
      },
    },
    version: '1.0.0',
    author: { name: 'Example Dev' },
    origin: 'community',
    categories: ['post-action'],
    engines: { motrix: '^2.0.0' },
    permissions: [],
    optionalPermissions: [],
    hostPermissions: [],
    screenshots: [],
    updatedAt: '2026-08-02',
    featured: false,
    compatible: true,
  }
}

describe('registryListing', () => {
  it('resolves one listing field-by-field for the requested locale', () => {
    expect(registryListing(entry().listing, 'zh-Hant-TW')).toEqual({
      name: 'Archive Unpacker',
      description: '繁體說明',
      features: [],
      keywords: ['archive'],
    })
  })

  it('does not treat zh-TW as a request for zh-CN', () => {
    const resolved = registryListing(entry().listing, 'zh-TW')
    expect(resolved.name).toBe('Archive Unpacker')
    expect(resolved.description).toBe('繁體說明')
    expect(resolved.name).not.toBe('简体解压器')
  })
})

describe('registry search composition', () => {
  it('indexes resolved/default listing fields and stable metadata', () => {
    const haystack = registrySearchText(entry(), 'zh-CN')
    expect(haystack).toContain('简体解压器')
    expect(haystack).toContain('archive unpacker')
    expect(haystack).toContain('压缩包')
    expect(haystack).toContain('example dev')
    expect(haystack).toContain('post-action')
  })

  it('does not index unrelated locale records', () => {
    expect(matchesRegistrySearch(entry(), 'アーカイブ', 'zh-CN')).toBe(false)
    expect(matchesRegistrySearch(entry(), 'archive', 'zh-CN')).toBe(true)
  })

  it('normalizes query and values with NFKC and locale lowercase', () => {
    expect(matchesRegistrySearch(entry(), 'ＡＲＣＨＩＶＥ', 'en-US')).toBe(true)
  })

  it('does not throw when a future default locale is unknown to ICU', () => {
    const future = entry()
    future.listing = {
      defaultLocale: 'abcd',
      localizations: {
        abcd: { name: 'Future Name', description: 'Future Description' },
      },
    }

    expect(() => registrySearchText(future, 'invalid_locale')).not.toThrow()
    expect(matchesRegistrySearch(future, 'FUTURE', 'invalid_locale')).toBe(true)
  })
})
