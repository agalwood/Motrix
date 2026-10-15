import { describe, expect, it } from 'vitest'
import { configToForm, formToConfig } from '@/options/takeoverForm'
import {
  excludedSiteDomain,
  siteDomain,
  withSiteExcluded,
} from '@/shared/siteExclusion'
import { TAKEOVER_DEFAULT } from '@/shared/takeover'

describe('site exclusion', () => {
  it.each([
    ['https://Files.Example.com:8080/path?token=secret', 'files.example.com'],
    ['http://localhost/file', 'localhost'],
    ['chrome://settings', null],
    ['about:blank', null],
    ['file:///tmp/file', null],
    [undefined, null],
  ])('extracts only an HTTP(S) domain: %s', (url, expected) => {
    expect(siteDomain(url)).toBe(expected)
  })

  it('round-trips a quick exclusion through the Options blacklist and preserves other preferences', () => {
    const excluded = withSiteExcluded(TAKEOVER_DEFAULT, 'example.com', true)
    expect(configToForm(excluded).denylist).toBe('example.com')
    const saved = { ...excluded, ...formToConfig(configToForm(excluded), 0) }
    expect(excludedSiteDomain(saved, 'example.com')).toBe('example.com')
    expect(withSiteExcluded(saved, 'example.com', false)).toEqual(
      TAKEOVER_DEFAULT
    )
  })

  it('removes only the exact domain, preserving other domains and conditional rules', () => {
    const config = {
      ...TAKEOVER_DEFAULT,
      rules: [
        {
          id: 'domains',
          match: { domains: ['.EXAMPLE.COM', 'other.test'] },
          action: 'chrome' as const,
        },
        {
          id: 'size',
          match: { domains: ['example.com'], minSizeMB: 10 },
          action: 'chrome' as const,
        },
      ],
    }
    const next = withSiteExcluded(config, 'example.com', false)
    expect(next.rules).toEqual([
      { ...config.rules[0], match: { domains: ['other.test'] } },
      config.rules[1],
    ])
    expect(excludedSiteDomain(next, 'example.com')).toBeNull()
  })

  it('does not remove an inherited parent rule or duplicate an existing exclusion', () => {
    const excluded = withSiteExcluded(TAKEOVER_DEFAULT, 'example.com', true)
    expect(excludedSiteDomain(excluded, 'files.example.com')).toBe(
      'example.com'
    )
    expect(excludedSiteDomain(excluded, 'notexample.com')).toBeNull()
    expect(withSiteExcluded(excluded, 'files.example.com', false)).toBe(
      excluded
    )
    expect(withSiteExcluded(excluded, 'example.com', true)).toBe(excluded)
  })

  it.each([
    'https://example.com',
    'example.com/path',
    'example.com:443',
    '',
    'example.com?secret=1',
  ])('rejects values that are not bare domains: %s', (domain) => {
    expect(() => withSiteExcluded(TAKEOVER_DEFAULT, domain, true)).toThrow(
      'invalid site exclusion'
    )
  })
})
