// Design §5: a builtin update whose trust surface GREW needs an explicit
// consent-diff confirmation; shrinking or unchanged surfaces install on the
// user's one click alone. Public command hash changes count as growth
// (schema drift on a public command is a contract change for callers).

import type { PluginManifest } from '@shared/types/plugin'
import { computePublicCommandHashes } from '../install/public-command-hash'

export interface BuiltinTrustDiff {
  changed: boolean
  added: string[]
}

function addedOf(
  prefix: string,
  before: ReadonlyArray<string> | undefined,
  after: ReadonlyArray<string> | undefined
): string[] {
  const prev = new Set(before ?? [])
  return (after ?? []).filter((x) => !prev.has(x)).map((x) => `${prefix}:${x}`)
}

function hashesEqual(
  a: Record<string, string>,
  b: Record<string, string>
): boolean {
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => a[k] === b[k])
}

export function builtinTrustSurfaceChanged(
  effective: PluginManifest,
  next: PluginManifest
): BuiltinTrustDiff {
  const added = [
    ...addedOf('perm', effective.permissions, next.permissions),
    ...addedOf('opt', effective.optionalPermissions, next.optionalPermissions),
    ...addedOf('host', effective.hostPermissions, next.hostPermissions),
  ]
  if (
    !hashesEqual(
      computePublicCommandHashes(effective),
      computePublicCommandHashes(next)
    )
  ) {
    added.push('publicCommands')
  }
  return { changed: added.length > 0, added }
}
