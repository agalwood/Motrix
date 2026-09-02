import type { PluginManifest } from '@shared/types/plugin'
import type { HookName } from '../host/bridge-protocol'
import {
  matchesAnyHostPermission,
  matchesHostPermission,
} from '../permissions/host-pattern'

export function matchPattern(pattern: string, url: string): boolean {
  return matchesHostPermission(pattern, url)
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
  if (hook !== 'beforeCreate') return true
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
  return matchesAnyHostPermission(hostPermissions, url)
}
