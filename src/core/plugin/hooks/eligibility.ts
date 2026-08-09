import type { PluginManifest } from '@shared/types/plugin'
import type { HookName } from '../host/bridge-protocol'

export function matchPattern(pattern: string, url: string): boolean {
  if (pattern === '<all_urls>') return /^https?:\/\//.test(url)
  // Chrome MV3 subset: scheme://host/path with * wildcards.
  // Transform order is critical to avoid mangling the scheme sentinel:
  //   1. Escape regex metacharacters (except *) — . becomes \., etc.
  //   2. Replace every remaining raw * with .* (wildcard expansion)
  //   3. Replace the leading .*:// (which came from the *:// scheme wildcard)
  //      with (http|https):// so *:// matches both schemes.
  const re = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/^\.\*:\/\//, '(http|https)://')
  return new RegExp(`^${re}$`).test(url)
}

export interface EligibilityInput {
  manifest: PluginManifest
  hook: HookName
  taskUrl?: string
}

export function isEligible({
  manifest,
  hook,
  taskUrl,
}: EligibilityInput): boolean {
  const hooks = manifest.contributes.hooks ?? {}
  if (!(hook in hooks)) return false
  if (hook !== 'beforeCreate' && hook !== 'beforeFinalize') return true
  if (!taskUrl) return true
  const patterns = manifest.hostPermissions ?? []
  if (patterns.length === 0) return false // I29
  return patterns.some((p) => matchPattern(p, taskUrl))
}

/**
 * True when any of the given hostPermission glob patterns matches `url`.
 * Empty/undefined patterns match nothing (mirrors isEligible rule I29).
 * Used by the mux pre-resolve seam to derive its resolvable-host set from a
 * specific resolver plugin's manifest hostPermissions — no hardcoded host list.
 */
export function urlMatchesHostPermissions(
  hostPermissions: ReadonlyArray<string> | undefined,
  url: string
): boolean {
  return (hostPermissions ?? []).some((p) => matchPattern(p, url))
}
