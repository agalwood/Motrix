import {
  type RegistryListing,
  type RegistryPluginDTO,
  type ResolvedRegistryListing,
  resolveRegistryListing,
} from '@shared/schemas/registry'

export function registryListing(
  listing: RegistryListing,
  requestedLocale: string
): ResolvedRegistryListing {
  return resolveRegistryListing(listing, requestedLocale)
}

function searchLocale(requestedLocale: string, defaultLocale: string): string {
  try {
    const locale = new Intl.Locale(requestedLocale)
    return locale.language === 'und' ? defaultLocale : locale.baseName
  } catch {
    return defaultLocale
  }
}

function searchValues(
  entry: RegistryPluginDTO,
  requestedLocale: string
): string[] {
  const resolved = registryListing(entry.listing, requestedLocale)
  const defaults = entry.listing.localizations[entry.listing.defaultLocale]
  if (!defaults) return []

  return [
    resolved.name,
    resolved.description,
    ...resolved.features,
    ...resolved.keywords,
    defaults.name ?? '',
    defaults.description ?? '',
    ...(defaults.features ?? []),
    ...(defaults.keywords ?? []),
    entry.id,
    entry.author.name,
    ...entry.categories,
  ]
}

function normalizeSearchValue(value: string, locale: string): string {
  const normalized = value.normalize('NFKC')
  try {
    return normalized.toLocaleLowerCase(locale)
  } catch {
    // The tolerant wire profile intentionally accepts syntactically safe tags
    // that this runtime's ICU may not know yet.
    return normalized.toLowerCase()
  }
}

export function registrySearchText(
  entry: RegistryPluginDTO,
  requestedLocale: string
): string {
  const locale = searchLocale(requestedLocale, entry.listing.defaultLocale)
  return searchValues(entry, requestedLocale)
    .map((value) => normalizeSearchValue(value, locale))
    .join('\n')
}

export function matchesRegistrySearch(
  entry: RegistryPluginDTO,
  query: string,
  requestedLocale: string
): boolean {
  const locale = searchLocale(requestedLocale, entry.listing.defaultLocale)
  const normalizedQuery = normalizeSearchValue(query, locale).trim()
  return (
    normalizedQuery.length === 0 ||
    registrySearchText(entry, requestedLocale).includes(normalizedQuery)
  )
}
