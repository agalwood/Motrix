import type { GeoIPSettings, GeoIPSource } from '@shared/types/geoip'

export interface GeoIPSourceDescriptor {
  /** Stable key used in settings and i18n. */
  key: GeoIPSource
  /** Default URL when no template substitution is needed. */
  url: string
  /**
   * True when the source delivers a raw `.mmdb` body directly. False
   * means the response needs decompression / archive extraction; Phase
   * 2 only supports direct sources.
   */
  isDirect: boolean
  /** True when the user must provide a license key to use this source. */
  requiresLicense: boolean
  /** Human-readable label fallback for builds without i18n loaded. */
  label: string
}

export const GEOIP_SOURCES: Record<GeoIPSource, GeoIPSourceDescriptor> = {
  loyalsoldier: {
    key: 'loyalsoldier',
    url: 'https://github.com/Loyalsoldier/geoip/releases/latest/download/Country.mmdb',
    isDirect: true,
    requiresLicense: false,
    label: 'Loyalsoldier',
  },
  p3terx: {
    key: 'p3terx',
    url: 'https://github.com/P3TERX/GeoLite.mmdb/releases/latest/download/GeoLite2-Country.mmdb',
    isDirect: true,
    requiresLicense: false,
    label: 'P3TERX',
  },
  maxmind: {
    key: 'maxmind',
    url: '',
    isDirect: false,
    requiresLicense: true,
    label: 'MaxMind (official)',
  },
  custom: {
    key: 'custom',
    url: '',
    isDirect: true,
    requiresLicense: false,
    label: 'Custom URL',
  },
}

/**
 * Compute the effective download URL for the configured source.
 *
 * Returns null when no usable URL can be produced — most importantly for
 * `maxmind` (Phase 2.1 will lift this) and for `custom` with an empty
 * URL field. Callers should surface a friendly error when null comes
 * back rather than attempting a download.
 */
export function resolveDownloadUrl(settings: GeoIPSettings): string | null {
  const descriptor = GEOIP_SOURCES[settings.source]
  if (!descriptor) return null

  if (descriptor.key === 'custom') {
    const trimmed = settings.customUrl.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  // Phase 2 limitation: MaxMind official source ships tar.gz bundles
  // and is deferred until the unpacker lands. Returning null here forces
  // the IPC handler to surface MaxmindUnsupported instead of attempting
  // a binary download that mmdb-lib will then fail to parse.
  if (!descriptor.isDirect || descriptor.requiresLicense) return null

  return descriptor.url
}
