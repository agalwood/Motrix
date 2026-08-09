export type GeoIPSource = 'loyalsoldier' | 'p3terx' | 'maxmind' | 'custom'

export interface GeoIPSettings {
  /** Master switch. Default false — opt-in to avoid any network call on
   *  upgrade. When false, peers tab country column stays empty. */
  enabled: boolean
  /** Selected preset; 'custom' uses customUrl verbatim. */
  source: GeoIPSource
  /** Used when source === 'custom'. Phase 2 supports direct .mmdb URLs only. */
  customUrl: string
  /** Reserved for Phase 2.1 MaxMind official source; stored masked in UI. */
  maxmindLicenseKey: string
  /** Periodic auto-update toggle. */
  autoUpdate: boolean
  /** Days between auto-update checks (Surge default = 7). */
  autoUpdateIntervalDays: number
  /** unix ms of the last successful download. 0 = never. */
  lastUpdatedAt: number
  /** Free-form version tag carried over from the source (release tag,
   *  ETag, or Content-Disposition filename). Empty when never downloaded. */
  databaseVersion: string
}

export interface CountryRef {
  /** ISO-3166-1 alpha-2 (e.g. 'US', 'CN'). */
  code: string
  /** Localized country name resolved on the renderer via Intl.DisplayNames. */
  name: string
}

export interface GeoIPStatus {
  enabled: boolean
  /** True when the on-disk mmdb file exists. */
  hasDatabase: boolean
  /** True when the in-memory mmdb-lib reader has the file open. */
  loaded: boolean
  lastUpdatedAt: number
  databaseVersion: string
  sizeBytes: number
  isDownloading: boolean
  /** Last download error message; cleared on the next successful update. */
  lastError: string | null
}

export interface DownloadProgress {
  bytesReceived: number
  /** -1 when Content-Length is unknown. */
  bytesTotal: number
  /** 0..1 when total is known, otherwise -1. */
  percent: number
}
