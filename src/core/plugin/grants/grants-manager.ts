// Per-plugin optional-permission grants store (spec §I30).
//
// Backing data: `_install.json.grants` — the same file `PluginInstaller`
// writes at commit time. This manager is the runtime gateway for *mutating*
// that field without going through the install flow, plus the read-side
// counterpart used by the renderer and (Phase 2) the CapabilityBridge.
//
// Builtins / dev plugins don't have an install record; updateGrants rejects
// them, and effectivePermissionsFor falls back to "all declared permissions"
// — they are trusted by construction.

import { AppError, ErrorCode } from '@shared/errors'
import type { GrantsMap } from '@shared/types/plugin-install'
import {
  readInstallRecord,
  writeInstallRecord,
} from '../install/install-record'
import type { PluginRegistry } from '../plugin-registry'

export interface GrantsManagerOptions {
  registry: PluginRegistry
  eventBus?: {
    emit(channel: 'event:pluginGrantsChanged', payload: unknown): void
  }
  policyBarrier?: <T>(
    pluginId: string,
    publish: () => Promise<T> | T
  ) => Promise<T>
}

export type PermissionRevokedHandler = (
  pluginId: string,
  revokedPermissions: readonly string[],
  at: number
) => Promise<number>

export class GrantsManager {
  private policyBarrier:
    | (<T>(pluginId: string, publish: () => Promise<T> | T) => Promise<T>)
    | undefined
  private permissionRevokedHandler: PermissionRevokedHandler | undefined
  private readonly mutationTails = new Map<string, Promise<void>>()

  constructor(private readonly opts: GrantsManagerOptions) {
    this.policyBarrier = opts.policyBarrier
  }

  bindPolicyBarrier(
    barrier: <T>(pluginId: string, publish: () => Promise<T> | T) => Promise<T>
  ): void {
    this.policyBarrier = barrier
  }

  bindPermissionRevoked(handler: PermissionRevokedHandler): void {
    this.permissionRevokedHandler = handler
  }

  /**
   * Read persisted grants. Returns `{}` for plugins without an install record
   * (builtins, dev plugins, or freshly-discovered community plugins whose
   * record write failed). UI callers should treat the empty map as "no
   * optional permission granted".
   */
  async getGrants(pluginId: string): Promise<GrantsMap> {
    const entry = this.opts.registry.get(pluginId)
    if (!entry) return {}
    const record = await readInstallRecord(entry.rootDir)
    if (!record) return {}
    return this.filterToOptional(pluginId, record.grants)
  }

  /**
   * Apply a patch over the current grants and persist. Patch keys must be
   * declared in `manifest.optionalPermissions`; unknown keys (including
   * required permissions, which are never user-revocable) throw
   * `plugin.grants.unknown_permission`. Builtins / dev plugins throw
   * `plugin.grants.not_supported`.
   *
   * Emits `Events.PluginGrantsChanged` after the write; consumers
   * (PluginHost in Phase 2) deactivate the plugin so the next activation
   * picks up the new effective permissions.
   */
  async updateGrants(pluginId: string, patch: GrantsMap): Promise<GrantsMap> {
    const persist = async (): Promise<GrantsMap> => {
      // Re-read every mutable input only after the Host has closed admission
      // and this plugin's policy mutation reaches the head of its queue. An
      // upgrade or another grant patch may have completed while this request
      // was waiting.
      const entry = this.opts.registry.get(pluginId)
      if (!entry) {
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          `plugin.grants.unknown_plugin: ${pluginId}`
        )
      }
      if (entry.origin !== 'community' || entry.dev) {
        throw new AppError(
          ErrorCode.PluginPermissionUnsupported,
          'plugin.grants.not_supported'
        )
      }

      const optional = new Set(entry.manifest.optionalPermissions ?? [])
      for (const key of Object.keys(patch)) {
        if (!optional.has(key)) {
          throw new AppError(
            ErrorCode.PluginPermissionUnsupported,
            `plugin.grants.unknown_permission: ${key}`
          )
        }
      }

      const record = await readInstallRecord(entry.rootDir)
      if (!record) {
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          'plugin.grants.install_record_missing'
        )
      }
      const next: GrantsMap = { ...record.grants, ...patch }
      const revokedPermissions = [...optional]
        .filter(
          (permission) =>
            record.grants[permission] === 'granted' &&
            next[permission] !== 'granted'
        )
        .sort()
      // The Host barrier has already closed admission, aborted live capability
      // leases, and drained the old worker. Publish the reversible grant file,
      // then terminalize affected durable deliveries. Restore the old record
      // if terminalization fails before admission reopens.
      await writeInstallRecord(entry.rootDir, { ...record, grants: next })
      try {
        if (revokedPermissions.length > 0) {
          await this.permissionRevokedHandler?.(
            pluginId,
            revokedPermissions,
            Date.now()
          )
        }
      } catch (error) {
        await writeInstallRecord(entry.rootDir, record)
        throw error
      }
      return this.filterToOptional(pluginId, next)
    }
    let filtered: GrantsMap
    if (this.policyBarrier) {
      filtered = await this.policyBarrier(pluginId, persist)
    } else {
      filtered = await this.withPluginMutation(pluginId, async () => {
        const result = await persist()
        this.opts.registry.bumpPolicyGeneration(pluginId)
        return result
      })
    }

    this.opts.eventBus?.emit('event:pluginGrantsChanged', { pluginId })
    return filtered
  }

  private async withPluginMutation<T>(
    pluginId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.mutationTails.get(pluginId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(
      () => current,
      () => current
    )
    this.mutationTails.set(pluginId, tail)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (this.mutationTails.get(pluginId) === tail) {
        this.mutationTails.delete(pluginId)
      }
    }
  }

  /**
   * Bulk read of all discovered plugins' grants. Returns a map keyed by
   * pluginId. Used by the renderer to compute card-level audience without
   * issuing N per-plugin IPC calls.
   */
  async listAllGrants(): Promise<Record<string, GrantsMap>> {
    const out: Record<string, GrantsMap> = {}
    // Each getGrants() reads an install record from disk; the reads are
    // independent, so run them concurrently instead of serializing.
    await Promise.all(
      [...this.opts.registry.entries()].map(async (entry) => {
        out[entry.manifest.id] = await this.getGrants(entry.manifest.id)
      })
    )
    return out
  }

  /**
   * Spec §I30 / §231 — effective permission set for runtime capability
   * gating: `required ∪ (optional ∩ granted)`. Builtins / dev get every
   * declared permission. Used by Phase 2's CapabilityBridge.
   */
  async effectivePermissionsFor(
    pluginId: string
  ): Promise<ReadonlySet<string>> {
    const entry = this.opts.registry.get(pluginId)
    if (!entry) return new Set()
    const required = entry.manifest.permissions ?? []
    const optional = entry.manifest.optionalPermissions ?? []
    if (entry.origin !== 'community' || entry.dev) {
      return new Set([...required, ...optional])
    }
    const record = await readInstallRecord(entry.rootDir)
    const grants: GrantsMap = record?.grants ?? {}
    const grantedOptional = optional.filter((p) => grants[p] === 'granted')
    return new Set([...required, ...grantedOptional])
  }

  // Drops keys not present in the current manifest's optionalPermissions
  // (handles upgrades that removed an optional permission — spec §I30 says
  // grants for removed permissions are dropped silently).
  private filterToOptional(pluginId: string, grants: GrantsMap): GrantsMap {
    const entry = this.opts.registry.get(pluginId)
    if (!entry) return {}
    const optional = new Set(entry.manifest.optionalPermissions ?? [])
    const out: GrantsMap = {}
    for (const [k, v] of Object.entries(grants)) {
      if (optional.has(k)) out[k] = v
    }
    return out
  }
}
