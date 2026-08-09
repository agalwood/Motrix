// Registry-only update scan (design §3.2). Community channel only here:
// builtin installs update exclusively through the Ed25519-verified
// BuiltinUpdater channel (2026-07-18 design) — Plan B extends this scan to
// emit channel:'builtin' items; the wire shape carries the channel from
// day one so that lands without a wire change. Dev plugins bypass the
// installer entirely and are never scanned.

import type { RegistryPluginDTO } from '@shared/schemas/registry'
import { semverGt } from '@shared/semver'

export interface PluginUpdateInfo {
  pluginId: string
  currentVersion: string
  latestVersion: string
  channel: 'community' | 'builtin'
}

export interface InstalledForScan {
  id: string
  version: string
  source?: { type: string }
}

export function scanForUpdates(
  installed: ReadonlyArray<InstalledForScan>,
  entries: ReadonlyArray<RegistryPluginDTO>
): PluginUpdateInfo[] {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const out: PluginUpdateInfo[] = []
  for (const plugin of installed) {
    const sourceType = plugin.source?.type
    if (sourceType === 'dev') continue
    const entry = byId.get(plugin.id)
    if (!entry?.compatible || !entry.package) continue
    if (!semverGt(entry.version, plugin.version)) continue

    if (sourceType === 'builtin' || sourceType === 'builtin-update') {
      // Builtin channel: only signed entries are ever offered — the
      // BuiltinUpdater will refuse unsigned ones anyway; don't dangle a
      // button that cannot succeed.
      if (entry.origin !== 'builtin' || !entry.package.signature) continue
      out.push({
        pluginId: plugin.id,
        currentVersion: plugin.version,
        latestVersion: entry.version,
        channel: 'builtin',
      })
      continue
    }

    out.push({
      pluginId: plugin.id,
      currentVersion: plugin.version,
      latestVersion: entry.version,
      channel: 'community',
    })
  }
  return out
}
