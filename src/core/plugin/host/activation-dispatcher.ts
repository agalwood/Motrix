import { getLogger } from '@core/logger'
import { AppError, ErrorCode } from '@shared/errors'
import type { PluginManifest } from '@shared/types/plugin'
import { isEligible } from '../hooks/eligibility'
import { matchesAnyHostPermission } from '../permissions/host-pattern'
import type { PluginRegistry } from '../plugin-registry'
import type { HookName } from './bridge-protocol'
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
  | { kind: 'hookDemand'; hook: HookName }

export interface HookCandidateInput {
  taskType?: 'http' | 'bt' | 'magnet' | 'ftp' | 'metalink'
  taskUrl?: string
}

export interface HookCandidateDescriptor {
  id: string
  manifest: PluginManifest
  generation: number
  executableDigest: string
  role: 'pre-resolve' | 'resolve' | 'enrich' | 'post-process' | 'audit'
}

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
      const matches = eff.has('*') || tokens.some((t) => eff.has(t))
      if (!matches) {
        skipped.push({
          id: dto.id,
          reason: `activationEvents ${[...eff].join(',')} ∉ tokens ${tokens.join(',')}`,
        })
        continue
      }
      if (
        event.kind === 'taskAdded' &&
        event.taskType === 'http' &&
        !matchesAnyHostPermission(reg.manifest.hostPermissions, event.url)
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

  /** Registry-backed Hook discovery; inactive/recycled workers remain visible. */
  candidatesForHook(
    hook: HookName,
    input: HookCandidateInput = {}
  ): HookCandidateDescriptor[] {
    const tokens = hookActivationTokens(input)
    const candidates: HookCandidateDescriptor[] = []
    for (const entry of this.registry.entries()) {
      if (!entry.enabled) continue
      if (!entry.executableDigest) continue
      if (
        !isEligible({
          manifest: entry.manifest,
          hook,
          taskUrl: hook === 'beforeCreate' ? input.taskUrl : undefined,
        })
      ) {
        continue
      }
      const activation = effectiveActivationSet(entry.manifest)
      if (
        tokens.length > 0 &&
        !activation.has('*') &&
        !tokens.some((token) => activation.has(token))
      ) {
        continue
      }
      candidates.push({
        id: entry.manifest.id,
        manifest: entry.manifest,
        generation: this.registry.policyGenerationFor(entry.manifest.id),
        executableDigest: entry.executableDigest,
        role: normalizeHookRole(entry.manifest.contributes.hooks?.[hook]?.role),
      })
    }
    return candidates.sort(compareHookCandidates)
  }

  /** Immediate demand activation, including reactivation after idle recycle. */
  async activateForHook(pluginId: string, hook: HookName): Promise<void> {
    if (this.host.isActive(pluginId)) return
    await this.admit([pluginId], { kind: 'hookDemand', hook })
  }

  async admitHookCandidates(
    candidates: ReadonlyArray<HookCandidateDescriptor>,
    hook: HookName
  ): Promise<void> {
    const inactive = candidates
      .map((candidate) => candidate.id)
      .filter((id) => !this.host.isActive(id))
    if (inactive.length > 0) {
      await this.admit(inactive, { kind: 'hookDemand', hook })
    }
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
        await this.activateForEvent(id, event)
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
      await this.activateForEvent(id, event)
    }
  }

  private activateForEvent(
    pluginId: string,
    event: HostActivationEvent
  ): Promise<void> {
    if (event.kind === 'hookDemand') {
      return this.host.activate(pluginId, { waitForDeactivation: true })
    }
    return this.host.activate(pluginId)
  }

  /**
   * Derive the set of plugin ids that must not be evicted for this event.
   *
   * Every running or already-admitted lane entry is critical. Evicting one
   * would turn the active-plugin cap into an unrelated task cancellation.
   */
  protected deriveCriticalSet(_event: HostActivationEvent): Set<string> {
    return new Set(
      this.host
        .activeMeta()
        .filter(
          (plugin) =>
            (plugin.runningEntries ?? 0) > 0 || (plugin.queuedEntries ?? 0) > 0
        )
        .map((plugin) => plugin.id)
    )
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
  if (event.kind === 'hookDemand') return []
  // taskAdded
  let scheme = ''
  try {
    scheme = new URL(event.url).protocol.replace(':', '')
  } catch {
    scheme = ''
  }
  return [`onTaskType:${event.taskType}`, `onProtocol:${scheme}`]
}

function hookActivationTokens(input: HookCandidateInput): string[] {
  const tokens: string[] = []
  if (input.taskType) tokens.push(`onTaskType:${input.taskType}`)
  if (input.taskUrl) {
    try {
      tokens.push(`onProtocol:${new URL(input.taskUrl).protocol.slice(0, -1)}`)
    } catch {
      // Invalid source URLs cannot add an activation token. beforeCreate's
      // structured host matcher separately fails the candidate closed.
    }
  }
  return tokens
}

const HOOK_ROLE_ORDER = new Map([
  ['pre-resolve', 0],
  ['resolve', 1],
  ['enrich', 2],
  ['post-process', 3],
  ['audit', 4],
])

function normalizeHookRole(
  role: string | undefined
): HookCandidateDescriptor['role'] {
  switch (role) {
    case 'pre-resolve':
    case 'resolve':
    case 'enrich':
    case 'post-process':
    case 'audit':
      return role
    default:
      return 'enrich'
  }
}

function compareHookCandidates(
  a: HookCandidateDescriptor,
  b: HookCandidateDescriptor
): number {
  const byRole =
    (HOOK_ROLE_ORDER.get(a.role) ?? 2) - (HOOK_ROLE_ORDER.get(b.role) ?? 2)
  if (byRole !== 0) return byRole
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
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
