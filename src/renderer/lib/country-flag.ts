/**
 * Convert an ISO-3166-1 alpha-2 country code to a regional indicator
 * emoji ("🇺🇸"). Returns the empty string for any input that isn't
 * exactly two ASCII letters — most importantly when the GeoIP layer
 * passes us null country.code, in which case the renderer leaves the
 * cell blank rather than showing a placeholder.
 */
export function countryCodeToFlag(code: string | null | undefined): string {
  if (code?.length !== 2) return ''
  const upper = code.toUpperCase()
  if (!/^[A-Z]{2}$/.test(upper)) return ''
  const base = 0x1f1e6 // REGIONAL INDICATOR SYMBOL LETTER A
  return String.fromCodePoint(
    base + (upper.charCodeAt(0) - 65),
    base + (upper.charCodeAt(1) - 65)
  )
}

/**
 * Resolve the localized country name via Intl.DisplayNames. Falls back
 * to the code itself when the runtime lacks a region table for the
 * requested locale (older Electron snapshots) or when the code is
 * missing.
 */
export function countryName(
  code: string | null | undefined,
  locale: string
): string {
  if (!code) return ''
  try {
    const dn = new Intl.DisplayNames([locale], { type: 'region' })
    return dn.of(code) ?? code
  } catch {
    return code
  }
}
