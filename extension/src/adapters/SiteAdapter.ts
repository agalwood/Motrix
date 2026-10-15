import type { UrlResolveParams, UrlResolveResult } from '@motrix/mdxp'

/** Adapter metadata reported to Motrix during motrix/initialize. */
export interface AdapterDecl {
  id: string
  version: string
  urlPatterns: string[]
  capabilities: Array<'resolve' | 'sniff' | 'batch'>
}

/** Runtime adapter implementation. Each site adapter implements this. */
export interface SiteAdapter extends AdapterDecl {
  /**
   * Cheap predicate: does this adapter handle `url`? Synchronous,
   * no network. <1ms target.
   */
  matchesUrl(url: string): boolean

  /**
   * Probe: returns metadata without extracting. <50ms target per
   * spec §6.2.
   */
  probe(url: string): {
    handled: boolean
    confidence?: 'high' | 'medium' | 'low'
  }

  /**
   * Resolve: extract downloadable selections. May be expensive.
   */
  resolve(
    url: string,
    preferences?: UrlResolveParams['preferences']
  ): Promise<UrlResolveResult>
}

/**
 * Convert an MDXP URL pattern (e.g. `*://*.youtube.com/*`) to a JS
 * regex. Mirrors Chrome match-pattern semantics: scheme://host/path,
 * with `*` wildcards in any segment.
 */
export function urlPatternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}
