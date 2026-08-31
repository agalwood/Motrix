import { getLogger } from '@core/logger'
import { AppError, ErrorCode } from '@shared/errors'
import type { PluginManifest } from '@shared/types/plugin'
import { urlMatchesHostPermissions } from '../hooks/eligibility'
import type { PluginRegistry } from '../plugin-registry'
import {
  type ActiveMeta,
  DEFAULT_MAX_ACTIVE_PLUGINS,
  type PluginHost,
} from './plugin-host'

const log = getLogger('plugin:activation')

export type HostActivationEvent =
  | { kind: 'startup' }
  | {
      kind: 'taskAdded'
      taskType: 'http' | 'bt' | 'magnet' | 'ftp' | 'metalink'
      url: string
    }
  | { kind: 'command'; commandId: string }

export interface PluginEvictedPayload {
  pluginId: string
  reason: 'cap' | 'manual' | 'idle'
}

export interface PluginActivationCapExceededPayload {
  unfittable: string[]
}

export interface ActivationDispatcherEmitter {
  emit(event: 'plugin.evicted', payload: PluginEvictedPayload): void
  emit(
    event: 'plugin.activation_cap_exceeded',
    payload: PluginActivationCapExceededPayload
  ): void
}

export class ActivationDispatcher {
  private readonly maxActive: number
  private readonly emitter: ActivationDispatcherEmitter | undefined

  constructor(
    private readonly registry: PluginRegistry,
    private readonly host: PluginHost,
    opts: { maxActive?: number; emitter?: ActivationDispatcherEmitter } = {}
  ) {
    this.maxActive = opts.maxActive ?? DEFAULT_MAX_ACTIVE_PLUGINS
    this.emitter = opts.emitter
  }

  /**
   * Main entry for backward compatibility. Collects matching inactive plugins
   * and delegates to `admit()` for cap enforcement + eviction.
   */
  async dispatch(event: HostActivationEvent): Promise<void> {
    const matchingInactive: string[] = []
    const skipped: Array<{ id: string; reason: string }> = []
    // Loop-invariant: tokens depend only on the event, not the per-plugin
    // registry entry, so derive them once before the scan.
    const tokens = tokensFor(event)
    for (const dto of this.registry.list()) {
      const reg = this.registry.get(dto.id)
      if (!reg) {
        skipped.push({ id: dto.id, reason: 'no registry entry' })
        continue
      }
      if (!reg.state.enabled) {
        skipped.push({ id: dto.id, reason: 'disabled' })
        continue
      }
      if (this.host.isActive(dto.id)) {
        skipped.push({ id: dto.id, reason: 'already active' })
        continue
      }
      const eff = effectiveActivationSet(reg.manifest)
      const matches = tokens.some((t) => eff.has(t))
      if (!matches) {
        skipped.push({
          id: dto.id,
          reason: `activationEvents ${[...eff].join(',')} ∉ tokens ${tokens.join(',')}`,
        })
        continue
      }
      if (
        event.kind === 'taskAdded' &&
        !urlMatchesHostPermissions(reg.manifest.hostPermissions, event.url)
      ) {
        skipped.push({
          id: dto.id,
          reason: `hostPermissions ${(reg.manifest.hostPermissions ?? []).join(',')} ∌ ${event.url}`,
        })
        continue
      }
      matchingInactive.push(dto.id)
    }
    log.info(
      { event, matchingInactive, skipped },
      'ActivationDispatcher.dispatch'
    )
    if (matchingInactive.length === 0) return
    await this.admit(matchingInactive, event)
  }

  /**
   * Activate a set of previously-filtered inactive plugins, evicting stale
   * plugins when the active count would exceed `maxActive`.
   *
   * Invariant I22: plugins in `criticalSet` are never evicted.
   */
  async admit(
    matchingInactive: string[],
    event: HostActivationEvent
  ): Promise<void> {
    const needed = this.host.activeIds().length + matchingInactive.length
    if (needed <= this.maxActive) {
      for (const id of matchingInactive) {
        await this.host.activate(id)
      }
      return
    }
    const slotsNeeded = needed - this.maxActive
    const criticalSet = this.deriveCriticalSet(event)
    const freed = await this.runEviction(slotsNeeded, criticalSet)
    if (freed < slotsNeeded) {
      this.emitter?.emit('plugin.activation_cap_exceeded', {
        unfittable: matchingInactive.filter((id) => !this.host.isActive(id)),
      })
      throw new AppError(
        ErrorCode.PluginActivationCapExceeded,
        'plugin.lifecycle.activation_cap_exceeded'
      )
    }
    for (const id of matchingInactive) {
      await this.host.activate(id)
    }
  }

  /**
   * Derive the set of plugin ids that must not be evicted for this event.
   *
   * T14 placeholder: always returns an empty set. The tier-ordering in
   * `runEviction` already protects critical roles by evicting 'audit' first.
   * T15 will replace this with real in-flight tracking via
   * `PluginHost.activeWithInFlightHook(taskId)` once TaskManager wires the
   * HookOrchestrator.
   */
  protected deriveCriticalSet(_event: HostActivationEvent): Set<string> {
    return new Set<string>()
  }

  /**
   * Evict up to `slots` non-critical plugins using a two-pass strategy:
   *   1. Idle-LRU: plugins idle > 60 s, oldest first.
   *   2. Tier-aware fallback: audit -> enrich -> post-process -> resolve ->
   *      pre-resolve, LRU within each tier.
   *
   * Returns the number of plugins actually evicted.
   */
  private async runEviction(
    slots: number,
    criticalSet: Set<string>
  ): Promise<number> {
    let freed = 0

    // Pass 1: idle candidates (idle > 60 s), sorted oldest-idle first.
    const meta = this.host.activeMeta()
    const idleCandidates = meta
      .filter((p) => !criticalSet.has(p.id) && p.idleMs > 60_000)
      .sort((a, b) => b.idleMs - a.idleMs)
    for (const c of idleCandidates) {
      if (freed >= slots) break
      await this.host.deactivate(c.id)
      this.emitter?.emit('plugin.evicted', { pluginId: c.id, reason: 'cap' })
      freed++
    }
    if (freed >= slots) return freed

    // Pass 2: tier-aware -- audit first, escalating toward pre-resolve.
    for (const tier of [
      'audit',
      'enrich',
      'post-process',
      'resolve',
      'pre-resolve',
    ] as const) {
      const tierCandidates = this.host
        .activeMeta()
        .filter((p) => !criticalSet.has(p.id) && p.evictionTier === tier)
        .sort((a, b) => b.idleMs - a.idleMs)
      for (const c of tierCandidates) {
        if (freed >= slots) break
        await this.host.deactivate(c.id)
        this.emitter?.emit('plugin.evicted', {
          pluginId: c.id,
          reason: 'cap',
        })
        freed++
      }
      if (freed >= slots) return freed
    }
    return freed
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function tokensFor(event: HostActivationEvent): string[] {
  if (event.kind === 'startup') return ['*', 'onStartup']
  if (event.kind === 'command') return [`onCommand:${event.commandId}`]
  // taskAdded
  let scheme = ''
  try {
    scheme = new URL(event.url).protocol.replace(':', '')
  } catch {
    scheme = ''
  }
  return [`onTaskType:${event.taskType}`, `onProtocol:${scheme}`]
}

function effectiveActivationSet(manifest: PluginManifest): Set<string> {
  const set = new Set<string>(manifest.activationEvents)
  // Implicit onCommand:<id> for every declared command (I23).
  for (const c of manifest.contributes.commands ?? []) {
    set.add(`onCommand:${c.id}`)
  }
  return set
}

// Re-export for test convenience.
export type { ActiveMeta }
