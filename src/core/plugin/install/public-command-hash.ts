// SHA-256 of (argsSchema, resultSchema) for every public command a plugin
// contributes. Recorded in `_install.json.consentSnapshot.publicCommands` so
// upgrades can detect when a callee's schema changed underneath the caller
// and trigger re-consent.
//
// Spec §2 L504-505: the host canonicalizes (recursive object-key sort)
// before hashing, so semantically-identical schemas authored with different
// key orderings produce the same schemaHash. Without this, a `pnpm
// reformat` that reorders keys would falsely look like a trust-surface
// change to every caller declaring this plugin in `invokesCommands`.

import { createHash } from 'node:crypto'
import type { PluginManifest } from '@shared/types/plugin'

interface CommandContribution {
  id: string
  public?: boolean
  argsSchema?: unknown
  resultSchema?: unknown
}

/**
 * Recursively sort object keys so structurally-identical inputs serialize
 * to the same string. Arrays preserve order (order is semantically
 * meaningful in JSON Schema `enum`, `items`, etc.). Non-plain objects are
 * passed through unchanged.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== 'object') return value
  // Skip class instances / non-plain objects.
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    out[k] = canonicalize((value as Record<string, unknown>)[k])
  }
  return out
}

export function computePublicCommandHashes(
  manifest: PluginManifest
): Record<string, string> {
  const out: Record<string, string> = {}
  const cmds = (manifest.contributes.commands ??
    []) as ReadonlyArray<CommandContribution>
  for (const c of cmds) {
    if (c.public !== true) continue
    const canonical = JSON.stringify(
      canonicalize({
        argsSchema: c.argsSchema ?? null,
        resultSchema: c.resultSchema ?? null,
      })
    )
    out[c.id] = createHash('sha256').update(canonical).digest('hex')
  }
  return out
}
