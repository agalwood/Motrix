export type LocaleDirection = 'ltr' | 'rtl'

export interface LocaleDefinition<Code extends string = string> {
  code: Code
  nativeName: string
  dir: LocaleDirection
}

/**
 * The single source of truth for locales shipped with the application.
 *
 * Resource registration, language selectors, runtime validation, and locale
 * tests all derive from this catalog. Adding a locale starts here and is then
 * enforced by TypeScript and `pnpm run check:i18n`.
 */
export const SUPPORTED_LOCALES = [
  { code: 'en-US', nativeName: 'English', dir: 'ltr' },
  { code: 'zh-CN', nativeName: '简体中文', dir: 'ltr' },
  { code: 'zh-TW', nativeName: '繁體中文', dir: 'ltr' },
] as const satisfies readonly LocaleDefinition[]

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]['code']

export const SUPPORTED_LOCALE_CODES = SUPPORTED_LOCALES.map(
  ({ code }) => code
) as unknown as readonly [SupportedLocale, ...SupportedLocale[]]

export const DEFAULT_LOCALE: SupportedLocale = 'en-US'
export const FALLBACK_LOCALE: SupportedLocale = DEFAULT_LOCALE

const definitionsByCode = new Map<SupportedLocale, LocaleDefinition>(
  SUPPORTED_LOCALES.map((definition) => [definition.code, definition])
)

const canonicalSupportedCodes = new Map<string, SupportedLocale>(
  SUPPORTED_LOCALES.map(({ code }) => [canonicalizeLocale(code) ?? code, code])
)

/** Return a canonical BCP-47 tag, or null for sentinels and invalid input. */
export function canonicalizeLocale(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const candidate = value
    .trim()
    .replace(/[.@].*$/, '')
    .replace(/_/g, '-')
  const sentinel = candidate.toLowerCase()
  if (
    !candidate ||
    sentinel === 'auto' ||
    sentinel === 'system' ||
    sentinel === 'c' ||
    sentinel === 'posix'
  ) {
    return null
  }
  try {
    return Intl.getCanonicalLocales(candidate)[0] ?? null
  } catch {
    return null
  }
}

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return (
    typeof value === 'string' &&
    SUPPORTED_LOCALE_CODES.includes(value as SupportedLocale)
  )
}

/**
 * Resolve user, system, or transport locale candidates into a shipped locale.
 * Exact BCP-47 matches win. Otherwise, a language/script match is preferred
 * before falling back to catalog order and finally DEFAULT_LOCALE.
 */
export function resolveSupportedLocale(
  ...candidates: ReadonlyArray<string | null | undefined>
): SupportedLocale {
  for (const candidate of candidates) {
    const canonical = canonicalizeLocale(candidate)
    if (!canonical) continue

    const exact = canonicalSupportedCodes.get(canonical)
    if (exact) return exact

    const requested = new Intl.Locale(canonical).maximize()
    const sameLanguage = SUPPORTED_LOCALES.filter(
      ({ code }) => new Intl.Locale(code).language === requested.language
    )
    if (sameLanguage.length === 0) continue

    const sameScript = sameLanguage.find(
      ({ code }) => new Intl.Locale(code).maximize().script === requested.script
    )
    return sameScript?.code ?? sameLanguage[0]?.code ?? DEFAULT_LOCALE
  }

  return DEFAULT_LOCALE
}

export function getLocaleDefinition(
  locale: SupportedLocale
): LocaleDefinition<SupportedLocale> {
  return definitionsByCode.get(locale) as LocaleDefinition<SupportedLocale>
}

export function getLocaleDirection(locale: SupportedLocale): LocaleDirection {
  return getLocaleDefinition(locale).dir
}
