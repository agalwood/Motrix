import { z } from 'zod'

// Vendored tolerant wire contract for Marketplace registry v2.
//
// Source of truth: plugin-registry/schema/registry.ts. Publisher authoring is
// intentionally stricter; this consumer preserves additive wire fields.

export const REGISTRY_URL = 'https://dl.motrix.app/registry/plugins.json'

/** Last-good cache file under userData, shared by both shells. */
export const REGISTRY_CACHE_FILENAME = 'registry-cache.json'

export const REGISTRY_PLUGIN_ID_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/

const LANGUAGE_RE = /^[a-z]{2,8}$/
const SCRIPT_RE = /^[A-Z][a-z]{3}$/
const REGION_RE = /^(?:[A-Z]{2}|[0-9]{3})$/
const VARIANT_RE = /^(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3})$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: the v2 wire contract rejects C0/C1 controls.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u

/**
 * ICU-independent consumer profile: canonical ASCII casing for language,
 * optional script/region, then variants. Extensions/private use are excluded.
 * Alias and registry knowledge are intentionally not required here.
 */
export function isMotrixLocaleTag(tag: string): boolean {
  if (tag.length === 0 || tag.length > 255 || !/^[A-Za-z0-9-]+$/.test(tag)) {
    return false
  }
  const parts = tag.split('-')
  if (!LANGUAGE_RE.test(parts[0] ?? '')) return false

  let index = 1
  if (SCRIPT_RE.test(parts[index] ?? '')) index += 1
  if (REGION_RE.test(parts[index] ?? '')) index += 1

  const variants = new Set<string>()
  for (; index < parts.length; index += 1) {
    const part = parts[index] ?? ''
    if (!VARIANT_RE.test(part) || variants.has(part)) return false
    variants.add(part)
  }
  return true
}

export const MotrixLocaleTagSchema = z
  .string()
  .refine(isMotrixLocaleTag, 'must be a safe Motrix BCP 47 profile tag')

function boundedPlainText(label: string, max: number) {
  return z
    .string()
    .min(1, `${label} must not be empty`)
    .max(max, `${label} must be at most ${max} UTF-16 code units`)
    .superRefine((value, ctx) => {
      if (value !== value.trim()) {
        ctx.addIssue({
          code: 'custom',
          message: `${label} must not have leading or trailing whitespace`,
        })
      }
      if (value !== value.normalize('NFC')) {
        ctx.addIssue({
          code: 'custom',
          message: `${label} must be Unicode NFC`,
        })
      }
      if (CONTROL_RE.test(value)) {
        ctx.addIssue({
          code: 'custom',
          message: `${label} must not contain C0/C1 control characters`,
        })
      }
    })
}

function uniqueTextList(label: string, itemMax: number) {
  return z
    .array(boundedPlainText(`${label} item`, itemMax))
    .max(20, `${label} must contain at most 20 items`)
    .superRefine((items, ctx) => {
      const seen = new Set<string>()
      for (const [index, item] of items.entries()) {
        if (seen.has(item)) {
          ctx.addIssue({
            code: 'custom',
            path: [index],
            message: `${label} items must be unique`,
          })
        }
        seen.add(item)
      }
    })
}

const localizationShape = {
  name: boundedPlainText('name', 80).optional(),
  description: boundedPlainText('description', 2_000).optional(),
  features: uniqueTextList('features', 160).optional(),
  keywords: uniqueTextList('keywords', 64).optional(),
}

/** Tolerant extension point: future own fields survive old-consumer parsing. */
export const RegistryLocalizationSchema = z
  .object(localizationShape)
  .passthrough()
export type RegistryLocalization = z.infer<typeof RegistryLocalizationSchema>

function addListingIssues(
  listing: {
    defaultLocale: string
    localizations: Record<string, RegistryLocalization>
  },
  ctx: z.RefinementCtx
): void {
  if (!Object.hasOwn(listing.localizations, listing.defaultLocale)) {
    ctx.addIssue({
      code: 'custom',
      path: ['defaultLocale'],
      message: 'defaultLocale must be an own key of localizations',
    })
    return
  }

  const defaultRecord = listing.localizations[listing.defaultLocale]
  if (
    !defaultRecord ||
    !Object.hasOwn(defaultRecord, 'name') ||
    !Object.hasOwn(defaultRecord, 'description')
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['localizations', listing.defaultLocale],
      message: 'default localization must contain name and description',
    })
  }

  for (const [locale, localization] of Object.entries(listing.localizations)) {
    if (
      locale !== listing.defaultLocale &&
      Object.keys(localization).length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['localizations', locale],
        message: 'non-default localization must contain at least one own field',
      })
    }
  }
}

export const RegistryListingSchema = z
  .object({
    defaultLocale: MotrixLocaleTagSchema,
    localizations: z.record(MotrixLocaleTagSchema, RegistryLocalizationSchema),
  })
  .passthrough()
  .superRefine(addListingIssues)
export type RegistryListing = z.infer<typeof RegistryListingSchema>

const authorShape = {
  name: z.string().min(1),
  url: z.url().optional(),
}
const enginesShape = { motrix: z.string().min(1) }
const packageShape = {
  url: z.url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive(),
  signature: z.string().min(1).optional(),
}

const commonPluginShape = {
  id: z.string().regex(REGISTRY_PLUGIN_ID_RE),
  version: z.string().min(1),
  origin: z.enum(['builtin', 'community']),
  categories: z.array(z.string().min(1)).min(1),
  permissions: z.array(z.string().min(1)).default([]),
  optionalPermissions: z.array(z.string().min(1)).default([]),
  hostPermissions: z.array(z.string().min(1)).default([]),
  repository: z.url().optional(),
  homepage: z.url().optional(),
  icon: z.string().optional(),
  screenshots: z.array(z.string()).default([]),
  updatedAt: z.iso.date(),
  featured: z.boolean().default(false),
}

// Registry v1 stored localized values in these plugin-root fields as
// `{ en, zh? }`. They are reserved so a mixed v1/v2 entry cannot be mistaken
// for a forward-compatible v2 extension.
const LEGACY_LOCALIZED_PLUGIN_ROOT_KEYS = [
  'name',
  'description',
  'features',
] as const

function addLegacyLocalizedRootKeyIssues(
  plugin: Record<string, unknown>,
  ctx: z.RefinementCtx
): void {
  for (const key of LEGACY_LOCALIZED_PLUGIN_ROOT_KEYS) {
    if (!Object.hasOwn(plugin, key)) continue
    ctx.addIssue({
      code: 'custom',
      path: [key],
      message: `legacy localized root field "${key}" is forbidden; use listing.localizations`,
    })
  }
}

export const RegistryPluginSchema = z
  .object({
    ...commonPluginShape,
    listing: RegistryListingSchema,
    author: z.object(authorShape).passthrough(),
    engines: z.object(enginesShape).passthrough(),
    package: z.object(packageShape).passthrough().optional(),
  })
  .passthrough()
  .superRefine(addLegacyLocalizedRootKeyIssues)
export type RegistryPlugin = z.infer<typeof RegistryPluginSchema>

function addDuplicateIdIssues(
  file: { plugins: Array<{ id: string }> },
  ctx: z.RefinementCtx
): void {
  const seen = new Set<string>()
  for (const [index, plugin] of file.plugins.entries()) {
    if (seen.has(plugin.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['plugins', index, 'id'],
        message: `duplicate plugin id "${plugin.id}"`,
      })
    }
    seen.add(plugin.id)
  }
}

export const RegistryFileSchema = z
  .object({
    version: z.literal(2),
    generatedAt: z.iso.datetime(),
    plugins: z.array(RegistryPluginSchema),
  })
  .passthrough()
  .superRefine(addDuplicateIdIssues)
export type RegistryFile = z.infer<typeof RegistryFileSchema>

export interface ResolvedRegistryListing {
  name: string
  description: string
  features: string[]
  keywords: string[]
}

function localeCandidates(
  listing: RegistryListing,
  requestedLocale: string
): string[] {
  const candidates: string[] = []
  const add = (candidate: string | undefined) => {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate)
  }

  let locale: Intl.Locale
  try {
    locale = new Intl.Locale(requestedLocale)
  } catch {
    return [listing.defaultLocale]
  }
  if (locale.language === 'und') return [listing.defaultLocale]

  const baseName = locale.baseName
  add(baseName)
  const parentParts = baseName.split('-')
  while (parentParts.length > 1) {
    parentParts.pop()
    if (parentParts.length > 1) add(parentParts.join('-'))
  }

  try {
    const maximized = locale.maximize()
    if (maximized.language !== 'und' && maximized.script) {
      add(`${maximized.language}-${maximized.script}`)
    }
  } catch {
    // Exact/base candidates remain useful if likely-subtag data is unavailable.
  }
  add(locale.language)
  add(listing.defaultLocale)
  return candidates
}

/** Deterministic field-level resolver shared by all App renderer consumers. */
export function resolveRegistryListing(
  listing: RegistryListing,
  requestedLocale: string
): ResolvedRegistryListing {
  const candidates = localeCandidates(listing, requestedLocale)
  const defaultRecord = listing.localizations[listing.defaultLocale]
  if (!defaultRecord) {
    throw new Error('invalid listing: defaultLocale is not present')
  }

  const resolve = (field: 'name' | 'description' | 'features' | 'keywords') => {
    for (const candidate of candidates) {
      const localization = listing.localizations[candidate]
      if (localization && Object.hasOwn(localization, field)) {
        return localization[field]
      }
    }
    return defaultRecord[field]
  }

  return {
    name: resolve('name') as string,
    description: resolve('description') as string,
    features: (resolve('features') as string[] | undefined) ?? [],
    keywords: (resolve('keywords') as string[] | undefined) ?? [],
  }
}

/** Registry entry annotated for the renderer with the host-version gate. */
export interface RegistryPluginDTO extends RegistryPlugin {
  compatible: boolean
}
