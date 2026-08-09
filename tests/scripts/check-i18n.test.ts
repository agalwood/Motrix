import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript checker intentionally has no declarations
import {
  checkI18n,
  extractPlaceholders,
  flattenScalarKeys,
} from '../../scripts/check-i18n.mjs'

interface Fixture {
  catalogModule: string
  localesDirectory: string
  root: string
}

const roots: string[] = []
const projectRoot = path.resolve(import.meta.dirname, '../..')
const checkerPath = path.join(projectRoot, 'scripts/check-i18n.mjs')

function createFixture(
  localeCodes: string[],
  resources: Record<string, unknown>,
  fallbackLocale = localeCodes[0]
): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'motrix-check-i18n-'))
  roots.push(root)
  const localesDirectory = path.join(root, 'locales')
  const catalogModule = path.join(root, 'catalog.mjs')
  mkdirSync(localesDirectory)
  writeFileSync(
    catalogModule,
    `export const SUPPORTED_LOCALES = ${JSON.stringify(
      localeCodes.map((code) => ({ code }))
    )}\nexport const FALLBACK_LOCALE = ${JSON.stringify(fallbackLocale)}\n`
  )
  for (const [locale, resource] of Object.entries(resources)) {
    const content =
      typeof resource === 'string'
        ? resource
        : `${JSON.stringify(resource, null, 2)}\n`
    writeFileSync(path.join(localesDirectory, `${locale}.json`), content)
  }
  return { catalogModule, localesDirectory, root }
}

function pluralResource(locale: string, label: string) {
  const resource: Record<string, unknown> = {
    greeting: `${label} {{name}}`,
    nested: { title: `${label} title` },
  }
  const categories = new Intl.PluralRules(locale).resolvedOptions()
    .pluralCategories
  for (const category of categories) {
    resource[`items_${category}`] = `${label} {{count}}`
  }
  return resource
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('check:i18n', () => {
  it('flattens nested scalar translation keys', () => {
    expect(
      Object.fromEntries(
        flattenScalarKeys({
          common: { title: 'Title', enabled: true },
          values: [1, null],
        })
      )
    ).toEqual({
      'common.title': 'Title',
      'common.enabled': true,
      'values.0': 1,
      'values.1': null,
    })
  })

  it('recognizes escaped, unescaped, and formatted interpolation', () => {
    expect(
      extractPlaceholders(
        'Hello {{ name }}, {{- markup}}: {{amount, currency}}'
      )
    ).toEqual(new Set(['name', 'markup', 'amount']))
  })

  it('accepts locale-specific plural categories for the same logical key', async () => {
    const fixture = createFixture(
      ['en-US', 'zh-CN', 'ar-EG'],
      Object.fromEntries(
        ['en-US', 'zh-CN', 'ar-EG'].map((locale) => [
          locale,
          pluralResource(locale, locale),
        ])
      ),
      'en-US'
    )

    const result = await checkI18n({
      catalog: ['en-US', 'zh-CN', 'ar-EG'],
      fallbackLocale: 'en-US',
      localesDirectory: fixture.localesDirectory,
    })

    expect(result.errors).toEqual([])
    expect(result.logicalKeyCount).toBe(3)
  })

  it('reports missing and unregistered locale files', async () => {
    const fixture = createFixture(
      ['en-US', 'fr-FR'],
      {
        'en-US': { title: 'Title' },
        'de-DE': { title: 'Titel' },
      },
      'en-US'
    )

    const result = await checkI18n({
      catalog: ['en-US', 'fr-FR'],
      fallbackLocale: 'en-US',
      localesDirectory: fixture.localesDirectory,
    })

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('fr-FR" has no matching file'),
        expect.stringContaining(
          'de-DE.json" is not registered in SUPPORTED_LOCALES'
        ),
      ])
    )
  })

  it('compares logical keys instead of raw plural suffixes', async () => {
    const fixture = createFixture(['en-US', 'zh-CN'], {
      'en-US': {
        title: 'Title',
        items_one: '{{count}} item',
        items_other: '{{count}} items',
      },
      'zh-CN': {
        items_other: '{{count}} 项',
      },
    })

    const result = await checkI18n({
      catalog: ['en-US', 'zh-CN'],
      fallbackLocale: 'en-US',
      localesDirectory: fixture.localesDirectory,
    })

    expect(result.errors).toEqual([expect.stringContaining('missing "title"')])
    expect(result.errors.join('\n')).not.toContain('items_one')
  })

  it('requires every plural category used by a locale', async () => {
    const fixture = createFixture(['ar-EG'], {
      'ar-EG': { items_other: '{{count}} عنصر' },
    })

    const result = await checkI18n({
      catalog: ['ar-EG'],
      fallbackLocale: 'ar-EG',
      localesDirectory: fixture.localesDirectory,
    })

    const required = new Intl.PluralRules('ar-EG').resolvedOptions()
      .pluralCategories
    for (const category of required.filter(
      (category) => category !== 'other'
    )) {
      expect(result.errors.join('\n')).toContain(`items_${category}`)
    }
  })

  it('rejects plural categories unsupported by the locale', async () => {
    const fixture = createFixture(['zh-CN'], {
      'zh-CN': {
        items_one: '{{count}} 项',
        items_other: '{{count}} 项',
      },
    })

    const result = await checkI18n({
      catalog: ['zh-CN'],
      fallbackLocale: 'zh-CN',
      localesDirectory: fixture.localesDirectory,
    })

    expect(result.errors).toEqual([
      expect.stringContaining(
        'plural family "items" has unsupported categories one'
      ),
    ])
  })

  it('allows i18next exact-zero overrides', async () => {
    const fixture = createFixture(['en-US'], {
      'en-US': {
        items_zero: 'No items ({{count}})',
        items_one: '{{count}} item',
        items_other: '{{count}} items',
      },
    })

    const result = await checkI18n({
      catalog: ['en-US'],
      fallbackLocale: 'en-US',
      localesDirectory: fixture.localesDirectory,
    })

    expect(result.errors).toEqual([])
  })

  it('rejects non-string translation leaves', async () => {
    const fixture = createFixture(['en-US'], {
      'en-US': {
        title: 'Title',
        enabled: true,
        retries: 3,
        missing: null,
      },
    })

    const result = await checkI18n({
      catalog: ['en-US'],
      fallbackLocale: 'en-US',
      localesDirectory: fixture.localesDirectory,
    })

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'translation key "enabled" must be a string; received boolean'
        ),
        expect.stringContaining(
          'translation key "retries" must be a string; received number'
        ),
        expect.stringContaining(
          'translation key "missing" must be a string; received null'
        ),
      ])
    )
  })

  it('checks placeholders within plural families and across locales', async () => {
    const fixture = createFixture(['en-US', 'zh-CN'], {
      'en-US': {
        greeting: 'Hello {{name}}',
        items_one: '{{count}} item',
        items_other: '{{total}} items',
      },
      'zh-CN': {
        greeting: '你好 {{user}}',
        items_other: '{{count}} 项',
      },
    })

    const result = await checkI18n({
      catalog: ['en-US', 'zh-CN'],
      fallbackLocale: 'en-US',
      localesDirectory: fixture.localesDirectory,
    })

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'placeholder mismatch inside logical key "items"'
        ),
        expect.stringContaining(
          'placeholders for logical key "greeting" differ from en-US'
        ),
      ])
    )
  })

  it('returns a non-zero CLI status with actionable errors', () => {
    const fixture = createFixture(
      ['en-US', 'fr-FR'],
      { 'en-US': { title: 'Title' } },
      'en-US'
    )
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        checkerPath,
        '--catalog-module',
        fixture.catalogModule,
        '--locales-dir',
        fixture.localesDirectory,
      ],
      { cwd: projectRoot, encoding: 'utf8' }
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('check:i18n failed')
    expect(result.stderr).toContain('fr-FR" has no matching file')
  })
})
