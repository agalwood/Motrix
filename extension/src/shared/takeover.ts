export type TakeoverAction = 'motrix' | 'chrome' | 'ask'
export type DownloadMode = 'confirm' | 'direct'

export interface TakeoverRule {
  id: string
  match: { domains?: string[]; minSizeMB?: number; mimePatterns?: string[] }
  action: TakeoverAction
}

export interface TakeoverConfig {
  downloadMode: DownloadMode
  /** Applies to every accepted submission, independently of automatic takeover. */
  openTaskPanelAfterSubmit: boolean
  enabled: boolean
  /** Bumped acknowledgement of the cookie-consent dialog; 0 = never consented. */
  consentAckVersion: number
  defaultAction: 'motrix' | 'chrome'
  /** Automatic downloads whose size remains unknown after probing. */
  unknownSizeAction: 'motrix' | 'chrome'
  rules: TakeoverRule[]
}

export type TakeoverSettings = Omit<TakeoverConfig, 'openTaskPanelAfterSubmit'>

/** Normalized download under consideration (browser-agnostic). */
export interface TakeoverTarget {
  url: string
  pageUrl: string
  pageTitle: string
  suggestedFilename: string
  /** URL-derived display name; leave remote filename discovery to Motrix. */
  filenameFromUrl?: boolean
  mime: string
  sizeBytes: number | null
  siteHint: string
  /** Early interception cancelled the response; browser choice must replay it. */
  nativeDownloadCancelled?: boolean | undefined
  origin: 'auto' | 'context-menu'
}

/** Raw fields a trigger adapter can supply before normalization. */
export interface RawTarget {
  url: string
  finalUrl?: string
  referrer?: string
  tabTitle?: string
  suggestedFilename?: string
  mime?: string
  sizeBytes?: number | null
  origin: 'auto' | 'context-menu'
}

export const TAKEOVER_DEFAULT: TakeoverConfig = {
  downloadMode: 'direct',
  openTaskPanelAfterSubmit: false,
  enabled: false,
  consentAckVersion: 0,
  defaultAction: 'motrix',
  unknownSizeAction: 'chrome',
  rules: [],
}

export const CONSENT_VERSION = 1
export const MIB = 1024 * 1024
export const QUALITY_SENTINEL = 'file'

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** Suffix match: host === entry or host ends with `.entry` (leading dots on entry ignored). */
export function hostSuffixMatch(host: string, entry: string): boolean {
  const h = host.toLowerCase()
  const e = entry.replace(/^\.+/, '').toLowerCase()
  if (e.length === 0) return false
  return h === e || h.endsWith(`.${e}`)
}

/** True iff `url` is a BitTorrent magnet link (`magnet:?…`). */
export function isMagnetUrl(url: string | undefined): url is string {
  return typeof url === 'string' && url.startsWith('magnet:?')
}

/** Decode a magnet link's `dn=` display-name hint, or undefined if absent. */
export function magnetDisplayName(uri: string): string | undefined {
  const q = uri.indexOf('?')
  if (q < 0) return undefined
  const dn = new URLSearchParams(uri.slice(q + 1)).get('dn')
  return dn !== null && dn.length > 0 ? dn : undefined
}
