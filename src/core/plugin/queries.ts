// Provider helpers for the Phase 1A plugin read-side queries:
//   - GetPluginConfig          → readPluginConfig
//   - GetContributionIndex     → buildContributionIndex
//   - CheckPluginCompatibility → checkPluginCompatibility
//   - GetPluginHookRank        → computePluginHookRank
//
// These are pure functions over data already in PluginRegistry + SettingsManager
// so they can be tested without the IPC transport. Wire-up lives in
// src/{main,server}/ipc/queries.ts.

import type { PluginManifest } from '@shared/types/plugin'
import { type RoleBand, sortByBand } from './hooks/role-band'
import { semverSatisfies } from './manifest/parse'

// ---------------------------------------------------------------------------
// Shared minimal indexed-plugin shape
//
// PluginRegistry.IndexedPlugin carries a full PluginStateRecord, but these
// helpers only need (manifest, origin, enabled). Decoupling here keeps the
// helpers unit-testable without booting a registry + SQLite store.
// ---------------------------------------------------------------------------

export interface IndexedPluginLike {
  manifest: PluginManifest
  origin: 'community' | 'builtin'
  enabled: boolean
}

// ---------------------------------------------------------------------------
// CheckPluginCompatibility
// ---------------------------------------------------------------------------

export interface CompatibilityResult {
  ok: boolean
  // Stable error code from spec §7 L2169-2259 error catalog.
  code?: string
  message?: string
}

// Permission names that are rejected for community plugins in Phase 1A
// (spec §2 L244, §4 L1125). `exec` is verified-only; community use → reject.
const COMMUNITY_FORBIDDEN_PERMISSIONS = new Set(['exec'])

export function checkPluginCompatibility(
  manifest: PluginManifest,
  hostVersion: string,
  opts: { origin?: 'community' | 'builtin' } = {}
): CompatibilityResult {
  // 1. engines.motrix range check (spec §2 L220, §7 L2177).
  const range = manifest.engines.motrix
  if (!semverSatisfies(hostVersion, range)) {
    return {
      ok: false,
      code: 'plugin.manifest.engine_version_too_old',
      message: `plugin requires host ${range}; running ${hostVersion}`,
    }
  }

  // 2. Community-forbidden permissions (spec §2 L244).
  const origin = opts.origin ?? 'community'
  if (origin === 'community') {
    for (const perm of manifest.permissions) {
      if (COMMUNITY_FORBIDDEN_PERMISSIONS.has(perm)) {
        return {
          ok: false,
          code: 'plugin.manifest.permissions.unsupported_on_runtime',
          message: `permission "${perm}" is verified-only and rejected for community plugins`,
        }
      }
    }
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// GetContributionIndex
// ---------------------------------------------------------------------------

export interface ContributionCommandEntry {
  pluginId: string
  commandId: string
  title: string
  public: boolean
}

export interface ContributionHookEntry {
  pluginId: string
  hook: string
  role: RoleBand
}

export interface ContributionConfigurationEntry {
  pluginId: string
  title?: string
  schema: unknown
}

export interface ContributionIndex {
  commands: ContributionCommandEntry[]
  hooks: ContributionHookEntry[]
  configurations: ContributionConfigurationEntry[]
}

export function buildContributionIndex(
  plugins: ReadonlyArray<IndexedPluginLike>
): ContributionIndex {
  const commands: ContributionCommandEntry[] = []
  const hooks: ContributionHookEntry[] = []
  const configurations: ContributionConfigurationEntry[] = []

  for (const p of plugins) {
    if (!p.enabled) continue
    const c = p.manifest.contributes
    if (c.commands) {
      for (const cmd of c.commands) {
        commands.push({
          pluginId: p.manifest.id,
          commandId: cmd.id,
          title: cmd.title,
          public: cmd.public ?? false,
        })
      }
    }
    if (c.hooks) {
      for (const [hook, entry] of Object.entries(c.hooks)) {
        if (entry?.role) {
          hooks.push({
            pluginId: p.manifest.id,
            hook,
            role: entry.role as RoleBand,
          })
        }
      }
    }
    if (c.configuration) {
      configurations.push({
        pluginId: p.manifest.id,
        title: c.configuration.title,
        schema: c.configuration.schema,
      })
    }
  }

  return { commands, hooks, configurations }
}

// ---------------------------------------------------------------------------
// GetPluginHookRank
// ---------------------------------------------------------------------------

export interface PluginHookRank {
  rank: number // 1-based position within the hook chain
  total: number // total participating plugins in the hook
  role: RoleBand
}

export function computePluginHookRank(
  plugins: ReadonlyArray<IndexedPluginLike>,
  pluginId: string,
  hook: string
): PluginHookRank | null {
  // Build the participating set: enabled plugins whose manifest declares a
  // role for this hook.
  const participants: Array<{ pluginId: string; role: RoleBand }> = []
  for (const p of plugins) {
    if (!p.enabled) continue
    const entry = p.manifest.contributes.hooks?.[hook]
    if (!entry?.role) continue
    participants.push({
      pluginId: p.manifest.id,
      role: entry.role as RoleBand,
    })
  }
  // sortByBand: role band ASC, then plugin id lexical ASC (spec §4 L777).
  const sorted = sortByBand(participants)
  const idx = sorted.findIndex((s) => s.pluginId === pluginId)
  if (idx < 0) return null
  return {
    rank: idx + 1,
    total: sorted.length,
    role: sorted[idx].role,
  }
}

// ---------------------------------------------------------------------------
// GetPluginConfig
// ---------------------------------------------------------------------------

// Reads the user-stored config for a plugin from app settings.
// Returns an empty object when the plugin has no stored config yet.
// Note: secret-typed fields are NOT decrypted here — that lives in the
// runtime ConfigCapabilityHost which has access to SecretStore.
export function readPluginConfig(
  appSettings: { plugins: Record<string, Record<string, unknown>> },
  pluginId: string
): Record<string, unknown> {
  return appSettings.plugins[pluginId] ?? {}
}
