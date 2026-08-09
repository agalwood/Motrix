import { describe, expect, it } from 'vitest'
import {
  isMotrixLocaleTag,
  REGISTRY_PLUGIN_ID_RE,
  RegistryFileSchema,
  RegistryPluginSchema,
  resolveRegistryListing,
} from './registry'
import conformance from './registry.conformance.json'
import fixture from './registry.fixture.json'

describe('registry contract fixture (lockstep)', () => {
  it('parses the v2 fixture without field loss', () => {
    const parsed = RegistryFileSchema.parse(fixture)
    expect(parsed.version).toBe(2)
    expect(parsed.plugins).toHaveLength(3)
    expect(parsed.plugins[0]?.listing.localizations['ja-JP']).toEqual({
      name: 'サンプル・アーカイブ展開',
      features: [],
    })
    expect(
      parsed.plugins.find((plugin) => plugin.id === 'motrix.url-resolver')
        ?.package?.signature
    ).toBe('c2lnbmF0dXJl')
  })

  it('applies defaults on the minimal entry', () => {
    const minimal = RegistryFileSchema.parse(fixture).plugins[1]
    expect(minimal?.permissions).toEqual([])
    expect(minimal?.optionalPermissions).toEqual([])
    expect(minimal?.hostPermissions).toEqual([])
    expect(minimal?.screenshots).toEqual([])
    expect(minimal?.featured).toBe(false)
  })

  it('rejects the v1 root version without an adapter', () => {
    expect(
      RegistryFileSchema.safeParse({ ...fixture, version: 1 }).success
    ).toBe(false)
  })
})

describe('Motrix BCP 47 wire profile', () => {
  it.each(['en-US', 'zh-Hant', 'ja', 'sl-1994-biske', 'iw-IL', 'und', 'abcd'])(
    'accepts safe wire tag %s',
    (tag) => {
      expect(isMotrixLocaleTag(tag)).toBe(true)
    }
  )

  it.each([
    'zh_cn',
    'zh-cn',
    'en-US-u-ca-gregory',
    'de-DE-x-phonebk',
    'e',
    `en-${'a'.repeat(256)}`,
  ])('rejects malformed wire tag %s', (tag) => {
    expect(isMotrixLocaleTag(tag)).toBe(false)
  })
})

describe('RegistryPluginSchema', () => {
  const base = RegistryFileSchema.parse(fixture).plugins[1]

  it('accepts unknown category slugs and preserves future fields', () => {
    const entry = {
      ...base,
      categories: ['brand-new-slug'],
      futurePluginField: true,
      listing: {
        ...base.listing,
        futureListingField: 'kept',
        localizations: {
          ...base.listing.localizations,
          fr: { tagline: 'Future field' },
        },
      },
    }
    const parsed = RegistryPluginSchema.parse(entry)
    expect(parsed.categories).toEqual(['brand-new-slug'])
    expect(parsed.futurePluginField).toBe(true)
    expect(parsed.listing.futureListingField).toBe('kept')
    expect(parsed.listing.localizations.fr).toEqual({ tagline: 'Future field' })
  })

  it('rejects malformed package hashes and plugin ids', () => {
    expect(
      RegistryPluginSchema.safeParse({
        ...base,
        package: {
          url: 'https://dl.motrix.app/x.zip',
          sha256: 'nope',
          size: 1,
        },
      }).success
    ).toBe(false)
    expect(REGISTRY_PLUGIN_ID_RE.test('motrix.url-resolver')).toBe(true)
    expect(REGISTRY_PLUGIN_ID_RE.test('no-namespace')).toBe(false)
    expect(REGISTRY_PLUGIN_ID_RE.test('Upper.Case')).toBe(false)
  })

  it.each<[string, unknown]>([
    ['name', { en: 'Legacy name', zh: '旧名称' }],
    ['description', { en: 'Legacy description', zh: '旧说明' }],
    ['features', { en: ['Legacy feature'], zh: ['旧功能'] }],
  ])('rejects the mixed v2 and legacy root field %s', (key, value) => {
    const result = RegistryPluginSchema.safeParse({
      ...base,
      [key]: value,
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: [key],
        message: `legacy localized root field "${key}" is forbidden; use listing.localizations`,
      })
    )
  })

  it('rejects an entry containing only legacy localized root fields', () => {
    const { listing: _listing, ...withoutListing } = base
    expect(
      RegistryPluginSchema.safeParse({
        ...withoutListing,
        name: { en: 'Legacy name', zh: '旧名称' },
        description: { en: 'Legacy description', zh: '旧说明' },
        features: { en: ['Legacy feature'], zh: ['旧功能'] },
      }).success
    ).toBe(false)
  })
})

describe('exact registry listing resolver', () => {
  const listing = {
    defaultLocale: 'en-US',
    localizations: {
      'en-US': {
        name: 'Default name',
        description: 'Default description',
        features: ['default feature'],
        keywords: ['default keyword'],
      },
      'zh-CN': { name: '简体名称' },
      'zh-Hant': { description: '繁體說明', features: [] },
      'sl-1994-biske': { name: 'Biske name' },
      fr: { name: 'Nom français', keywords: [] },
    },
  }

  it.each([
    ['fr-FR', 'Nom français', 'Default description'],
    ['zh-TW', 'Default name', '繁體說明'],
    ['zh-CN', '简体名称', 'Default description'],
    ['zh-TW-u-ca-chinese', 'Default name', '繁體說明'],
    ['sl-1994-biske-rozaj', 'Biske name', 'Default description'],
  ])('resolves %s field-by-field', (requested, name, description) => {
    expect(resolveRegistryListing(listing, requested)).toMatchObject({
      name,
      description,
    })
  })

  it.each(['invalid_locale', 'und', 'und-Latn', 'und-Cyrl'])(
    'uses only the default record for %s',
    (requested) => {
      expect(resolveRegistryListing(listing, requested)).toEqual({
        name: 'Default name',
        description: 'Default description',
        features: ['default feature'],
        keywords: ['default keyword'],
      })
    }
  )

  it('does not choose an arbitrary sibling region', () => {
    const onlySimplified = {
      defaultLocale: 'en-US',
      localizations: {
        'en-US': { name: 'English', description: 'English description' },
        'zh-CN': { name: '简体中文', description: '简体说明' },
      },
    }
    expect(resolveRegistryListing(onlySimplified, 'zh-TW').name).toBe('English')
  })

  it('treats explicit empty arrays as overrides', () => {
    expect(resolveRegistryListing(listing, 'zh-Hant-TW').features).toEqual([])
    expect(resolveRegistryListing(listing, 'fr-FR').keywords).toEqual([])
  })

  it('is independent of locale-map insertion order', () => {
    const reversed = {
      ...listing,
      localizations: Object.fromEntries(
        Object.entries(listing.localizations).reverse()
      ),
    }
    expect(resolveRegistryListing(reversed, 'zh-TW')).toEqual(
      resolveRegistryListing(listing, 'zh-TW')
    )
  })
})

type PathPart = string | number
type CorpusOperation = {
  op: 'set' | 'delete' | 'appendCopy'
  path: PathPart[]
  from?: PathPart[]
  value?: unknown
}

function atPath(root: unknown, parts: PathPart[]): unknown {
  let value = root
  for (const part of parts) {
    if (typeof value !== 'object' || value === null) return undefined
    value = (value as Record<PropertyKey, unknown>)[part]
  }
  return value
}

function materializeCase(operations: CorpusOperation[]): unknown {
  const result: unknown = structuredClone(conformance.baseFile)
  for (const operation of operations) {
    if (operation.op === 'appendCopy') {
      const target = atPath(result, operation.path)
      if (!Array.isArray(target)) throw new Error('invalid appendCopy target')
      target.push(structuredClone(atPath(result, operation.from ?? [])))
      continue
    }
    const parent = atPath(result, operation.path.slice(0, -1))
    if (typeof parent !== 'object' || parent === null) {
      throw new Error('invalid conformance operation path')
    }
    const key = operation.path.at(-1)
    if (key === undefined) throw new Error('empty conformance operation path')
    const target = parent as Record<PropertyKey, unknown>
    if (operation.op === 'delete') delete target[key]
    else target[key] = structuredClone(operation.value)
  }
  return result
}

describe('shared tolerant-wire conformance corpus', () => {
  for (const corpusCase of conformance.cases) {
    it(corpusCase.id, () => {
      const input = materializeCase(corpusCase.operations as CorpusOperation[])
      const wire = RegistryFileSchema.safeParse(input)
      expect(wire.success).toBe(corpusCase.wireExpected.accepted)
      if (!wire.success) return

      for (const preserved of corpusCase.wireExpected.preservedPaths ?? []) {
        expect(atPath(wire.data, preserved as PathPart[])).toEqual(
          atPath(input, preserved as PathPart[])
        )
      }

      if (corpusCase.resolverExpected) {
        const plugin = wire.data.plugins.find(
          (entry) => entry.id === corpusCase.resolverExpected?.pluginId
        )
        expect(plugin).toBeDefined()
        expect(
          resolveRegistryListing(
            plugin!.listing,
            corpusCase.resolverExpected.requestedLocale
          )
        ).toEqual(corpusCase.resolverExpected.resolved)
      }
    })
  }
})
