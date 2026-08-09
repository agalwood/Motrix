import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Worker } from 'node:worker_threads'
import type { SupportedLocale } from '@shared/constants/locales'
import { AppError, ErrorCode } from '@shared/errors'
import type { PluginManifest } from '@shared/types/plugin'
import type { FfmpegDetection } from '../capabilities/ffmpeg-detect'
import type { CapabilityHost } from '../capabilities/interface'
import type { GrantsManager } from '../grants/grants-manager'
import { ffmpegSatisfies } from '../install/ffmpeg-semver'
import { readMoextEntry } from '../install/moext-reader'
import { resolveInsidePluginDir } from '../manifest/path-safety'
import type { PluginRegistry } from '../plugin-registry'
import type { PluginStateStore } from '../state/plugin-state-store'
import { verifyBuiltinSignature } from '../update/signature'
import type { HookName } from './bridge-protocol'
import { CapabilityBridge } from './capability-bridge'

/**
 * Per-plugin activity metadata returned by `PluginHost.activeMeta()`.
 * Used by `ActivationDispatcher.runEviction()` to pick LRU / tier candidates.
 */
export interface ActiveMeta {
  id: string
  lastActivityAt: number
  /** Milliseconds since the plugin last handled a hook or was activated. */
  idleMs: number
  /**
   * The "highest" role band the plugin contributes to.
   * Priority (least critical = evicted first): audit < enrich < post-process
   * < resolve < pre-resolve.
   * A plugin with no hooks (commands-only) falls into 'audit'.
   */
  evictionTier: 'audit' | 'enrich' | 'post-process' | 'resolve' | 'pre-resolve'
}

/**
 * Active plugin descriptor exposed to Plan C orchestration code. Includes the
 * manifest (needed for eligibility + role lookup) and the bridge/worker pair
 * (needed for hook invocation and the abort backstop).
 */
export interface ActivePluginInfo {
  id: string
  manifest: PluginManifest
  bridge: CapabilityBridge
  worker: Worker
}

export interface PluginHostOptions {
  registry: PluginRegistry
  stateStore: PluginStateStore
  capabilityHost: CapabilityHost
  workerScriptPath: string
  maxActivePlugins?: number
  idleDisposeMs?: number
  activationTimeoutMs?: number
  /** Budget in ms for worker-side onDeactivate handlers. Default 2000. */
  deactivateBudgetMs?: number
  appVersion: string
  runtime: 'electron' | 'server'
  hostLanguage: SupportedLocale
  /**
   * Spec §I30 — optional grants manager. When provided, the host resolves
   * `effectivePermissions = required ∪ (optional ∩ granted)` before each
   * activation and passes it to the bridge for runtime gating. Absent →
   * bridge falls back to "all declared permissions" (no gating). Wired in
   * production from main/server; tests can omit.
   */
  pluginGrants?: GrantsManager
  /**
   * Optional ffmpeg detector. When provided the host probes ffmpeg at
   * activation time and enforces `engines.ffmpeg` range requirements.
   * Absent → no ffmpeg gate (all plugins pass regardless of manifest range).
   */
  ffmpegDetect?: () => Promise<FfmpegDetection>
  /**
   * Injectable for tests; defaults to the pinned build-time keys. Mirrors
   * `PluginRegistryOptions.signingPubkeys` — the host re-verifies
   * bundle.moext against the SAME trust root the registry used at scan
   * time (2026-07-18 design §4) before trusting its code at activation.
   */
  signingPubkeys?: ReadonlyArray<string>
}

interface Active {
  bridge: CapabilityBridge
  manifest: PluginManifest
  lastActivityAt: number
  registrations: Array<{ kind: 'hook' | 'command'; key: string }>
  /**
   * Snapshot taken at activation time. `true` when the plugin does not
   * declare ffmpeg at all (vacuously satisfied), or when detection met the
   * declared `engines.ffmpeg` range. `false` only when the plugin declares
   * `optionalPermissions: ['ffmpeg']` and detection was missing or below
   * range (required+miss always throws before this field is stored).
   */
  ffmpegAdvertised: boolean
}

/**
 * Default soft cap on concurrently-active plugins, shared by PluginHost and
 * ActivationDispatcher so their independent defaults can't silently diverge.
 */
export const DEFAULT_MAX_ACTIVE_PLUGINS = 32

export class PluginHost {
  private readonly active = new Map<string, Active>()
  // In-flight activations keyed by pluginId, so concurrent activate() calls
  // for the same plugin share one promise instead of each spawning a worker.
  private readonly activating = new Map<string, Promise<void>>()
  private readonly maxActivePlugins: number
  private readonly idleDisposeMs: number
  private readonly activationTimeoutMs: number
  private readonly deactivateBudgetMs: number
  private idleTimer?: NodeJS.Timeout
  private unsubscribeLocale: () => void = () => {}

  constructor(private readonly opts: PluginHostOptions) {
    this.maxActivePlugins = opts.maxActivePlugins ?? DEFAULT_MAX_ACTIVE_PLUGINS
    // Spec §7 L2149 — Plugin Active → 5 min no hook/capability/timer activity
    // → dispose VM → Inactive. Env override exists for ops tuning (e.g. a
    // long-running server with rare hooks may want a higher value).
    this.idleDisposeMs =
      opts.idleDisposeMs ??
      parsePositiveInt(process.env.MOTRIX_PLUGIN_IDLE_DISPOSE_MS) ??
      5 * 60_000
    this.activationTimeoutMs = opts.activationTimeoutMs ?? 5_000
    this.deactivateBudgetMs = opts.deactivateBudgetMs ?? 2_000
    this.idleTimer = setInterval(() => this.sweepIdle(), 30_000)
    this.idleTimer.unref?.()
    this.unsubscribeLocale = this.opts.capabilityHost.onLocaleChange((lang) => {
      this.broadcastLocaleChange(lang)
    })
  }

  private broadcastLocaleChange(_lang: string): void {
    for (const [pluginId, active] of this.active) {
      try {
        const snap = this.opts.capabilityHost.i18nSnapshot(pluginId)
        active.bridge.postLocaleChange(
          snap.language,
          snap.dir,
          snap.currentDict
        )
      } catch (error) {
        // A terminated/broken worker must not prevent other active plugins
        // from receiving the same committed locale snapshot.
        try {
          this.opts.capabilityHost
            .createLog(pluginId)
            .warn('plugin locale broadcast failed', {
              error: error instanceof Error ? error.message : String(error),
            })
        } catch {
          // Logging is best-effort at this isolation boundary.
        }
      }
    }
  }

  isActive(pluginId: string): boolean {
    return this.active.has(pluginId)
  }

  /**
   * Whether the plugin's ffmpeg surface advertises as available. Reflects
   * the snapshot taken at activate time. Returns undefined when the plugin
   * is not active.
   */
  getFfmpegAdvertised(pluginId: string): boolean | undefined {
    return this.active.get(pluginId)?.ffmpegAdvertised
  }

  activeIds(): string[] {
    return [...this.active.keys()]
  }

  /**
   * Invoke a command handler registered inside `pluginId`'s VM. Plan D's
   * `CrossPluginInvoker` calls this after all safeguards pass — every
   * trust gate (declared/public/throttle/rate/size/schema) is enforced
   * upstream, so the host's job here is purely to drive the round-trip
   * over the bridge. Any error thrown by the worker handler surfaces
   * as a rejection that `CrossPluginInvoker` then wraps as
   * `plugin.command.handler_threw` (callee stack never reaches caller).
   */
  invokeCommand(
    pluginId: string,
    commandId: string,
    args: unknown
  ): Promise<unknown> {
    const a = this.active.get(pluginId)
    if (!a) {
      return Promise.reject(
        new AppError(
          ErrorCode.PluginRuntimeFault,
          'plugin.command.not_available'
        )
      )
    }
    a.lastActivityAt = Date.now()
    return a.bridge.callPlugin(commandId, args)
  }

  async activate(pluginId: string): Promise<void> {
    const existing = this.active.get(pluginId)
    if (existing) {
      existing.lastActivityAt = Date.now()
      return
    }
    // Coalesce concurrent activations. `active` is only populated after the
    // awaits in doActivate (ffmpeg detect, bundle read, permission
    // resolution), so two overlapping calls would otherwise both pass the
    // guard above, both spawn a worker, and the second active.set() would
    // orphan the first bridge. Share one in-flight promise keyed by pluginId.
    const inFlight = this.activating.get(pluginId)
    if (inFlight) return inFlight
    const promise = this.doActivate(pluginId).finally(() => {
      this.activating.delete(pluginId)
    })
    this.activating.set(pluginId, promise)
    return promise
  }

  private async doActivate(pluginId: string): Promise<void> {
    const indexed = this.opts.registry.get(pluginId)
    if (!indexed) {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        `unknown plugin: ${pluginId}`
      )
    }
    if (!indexed.state.enabled) {
      throw new AppError(
        ErrorCode.PluginRuntimeFault,
        `plugin ${pluginId} is disabled`
      )
    }
    if (this.active.size >= this.maxActivePlugins) {
      throw new AppError(
        ErrorCode.PluginActivationCapExceeded,
        `active plugin cap (${this.maxActivePlugins}) reached`
      )
    }

    const needsFfmpeg =
      indexed.manifest.permissions.includes('ffmpeg') ||
      (indexed.manifest.optionalPermissions ?? []).includes('ffmpeg')

    let ffmpegDetection: FfmpegDetection = { available: false }
    if (needsFfmpeg && this.opts.ffmpegDetect) {
      ffmpegDetection = await this.opts.ffmpegDetect()
    }

    const ffmpegSatisfied =
      ffmpegDetection.available &&
      ffmpegSatisfies(
        ffmpegDetection.version ?? '',
        indexed.manifest.engines.ffmpeg ?? null
      )

    if (indexed.manifest.permissions.includes('ffmpeg') && !ffmpegSatisfied) {
      this.opts.stateStore.recordError(
        pluginId,
        'plugin.manifest.engines.ffmpeg_too_old'
      )
      this.opts.registry.refreshState(pluginId)
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        'plugin.manifest.engines.ffmpeg_too_old'
      )
    }

    const ffmpegAdvertised = !needsFfmpeg || ffmpegSatisfied

    // manifest.main is only length-validated by the schema; contain it to the
    // plugin's own dir so "../../x" can't make us read+eval a file elsewhere.
    // Kept unconditionally (including the overlay path below) — cheap and
    // harmless even when the overlay's actual source of truth is
    // bundle.moext, not this on-disk path.
    const bundlePath = resolveInsidePluginDir(
      indexed.rootDir,
      indexed.manifest.main
    )
    if (!bundlePath) {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        `plugin.manifest.main_escapes_dir: ${indexed.manifest.main}`
      )
    }

    let bundleSource: string
    if (indexed.overlay) {
      // Firefox packed-XPI model (2026-07-18 design §4): a builtin
      // hot-update overlay's EXECUTED CODE comes from the signature-verified
      // bundle.moext, never the separately-tamperable extracted tree — an
      // attacker who can write userData keeps the signed bundle but tampers
      // the tree would otherwise get unverified code run with builtin
      // privilege. Re-verify on every activation; nothing here is cached
      // across the signature check performed at scan time.
      const moextBytes = await readFile(
        path.join(indexed.rootDir, 'bundle.moext')
      )
      if (
        !verifyBuiltinSignature(
          moextBytes,
          indexed.overlay.signature,
          this.opts.signingPubkeys
        )
      ) {
        this.opts.stateStore.recordError(
          pluginId,
          'plugin.update.builtin_bad_signature'
        )
        this.opts.registry.refreshState(pluginId)
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          'plugin.update.builtin_bad_signature'
        )
      }
      const entryBytes = await readMoextEntry(moextBytes, indexed.manifest.main)
      if (!entryBytes) {
        this.opts.stateStore.recordError(
          pluginId,
          'plugin.update.builtin_bundle_entry_missing'
        )
        this.opts.registry.refreshState(pluginId)
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          'plugin.update.builtin_bundle_entry_missing'
        )
      }
      bundleSource = entryBytes.toString('utf8')
    } else {
      bundleSource = await readFile(bundlePath, 'utf8')
    }

    let resolveReady: () => void
    let rejectReady: (e: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })

    const effectivePermissions = this.opts.pluginGrants
      ? await this.opts.pluginGrants.effectivePermissionsFor(pluginId)
      : undefined

    const bridge = new CapabilityBridge(
      {
        pluginId,
        manifest: indexed.manifest,
        bundleSource,
        capabilityHost: this.opts.capabilityHost,
        workerScriptPath: this.opts.workerScriptPath,
        heapMB: indexed.manifest.requestedHeapMB ?? 32,
        appVersion: this.opts.appVersion,
        runtime: this.opts.runtime,
        hostLanguage: this.opts.hostLanguage,
        effectivePermissions,
      },
      {
        onReady: () => {
          this.opts.stateStore.markActivated(pluginId, Date.now())
          this.opts.registry.refreshState(pluginId)
          resolveReady()
        },
        onRegister: (kind, key) => {
          this.active.get(pluginId)?.registrations.push({ kind, key })
        },
        onFatal: (code, message) => {
          this.opts.stateStore.recordError(pluginId, `${code}: ${message}`)
          this.opts.registry.refreshState(pluginId)
          void this.deactivate(pluginId)
          rejectReady(new AppError(ErrorCode.PluginRuntimeFault, message))
        },
      }
    )
    this.active.set(pluginId, {
      bridge,
      manifest: indexed.manifest,
      lastActivityAt: Date.now(),
      registrations: [],
      ffmpegAdvertised,
    })

    const timeoutMs = this.activationTimeoutMs
    let timeoutHandle: NodeJS.Timeout | undefined
    const timeoutP = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new AppError(
            ErrorCode.PluginActivationTimeout,
            `plugin ${pluginId} did not become ready within ${timeoutMs} ms`
          )
        )
      }, timeoutMs)
      timeoutHandle.unref?.()
    })

    try {
      await Promise.race([ready, timeoutP])
    } catch (e) {
      void this.deactivate(pluginId)
      throw e
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }

  async deactivate(pluginId: string): Promise<void> {
    const a = this.active.get(pluginId)
    if (!a) return
    this.active.delete(pluginId)

    // 1. Run worker-side deactivate handlers (budget enforced by bridge).
    try {
      await a.bridge.runDeactivate(this.deactivateBudgetMs)
    } catch (e) {
      this.opts.capabilityHost
        .createLog(pluginId)
        .warn('worker deactivate failed', {
          error: (e as Error).message,
          code: (e as Error & { code?: string }).code,
        })
    }

    // 2. Run host-side deactivate handlers (LifecycleCapabilityHost registry).
    // Guard: lifecycle may be absent in minimal test stubs.
    if (this.opts.capabilityHost.lifecycle) {
      try {
        await this.opts.capabilityHost.lifecycle.runDeactivate(pluginId)
      } catch (e) {
        this.opts.capabilityHost
          .createLog(pluginId)
          .warn('host deactivate failed', {
            error: (e as Error).message,
            code: (e as Error & { code?: string }).code,
          })
      }
    }

    // 3. Tear down bridge and mark inactive.
    await a.bridge.dispose()
    this.opts.stateStore.setStatus(pluginId, 'inactive')
    this.opts.registry.refreshState(pluginId)
  }

  /**
   * Plan C — list every currently active plugin with the descriptors the
   * HookOrchestrator needs (manifest for eligibility/role, bridge for hook
   * invocation, worker for the abort backstop).
   */
  allActive(): ActivePluginInfo[] {
    const out: ActivePluginInfo[] = []
    for (const [id, a] of this.active.entries()) {
      out.push({
        id,
        manifest: a.manifest,
        bridge: a.bridge,
        worker: a.bridge.getWorker(),
      })
    }
    return out
  }

  /**
   * Plan C T14 — per-plugin activity metadata used by ActivationDispatcher
   * eviction. A plugin with no hooks (commands only) derives tier 'audit' —
   * the least-critical role and therefore the first-to-evict bucket.
   */
  activeMeta(): ActiveMeta[] {
    const now = Date.now()
    return [...this.active.entries()].map(([id, a]) => ({
      id,
      lastActivityAt: a.lastActivityAt,
      idleMs: now - a.lastActivityAt,
      evictionTier: deriveEvictionTier(a.manifest),
    }))
  }

  /** Plan C — bridge accessor used by HookOrchestrator and tests. */
  bridgeFor(pluginId: string): CapabilityBridge | undefined {
    return this.active.get(pluginId)?.bridge
  }

  /** Plan C — worker accessor used by `newHookAbort` for the terminate path. */
  workerFor(pluginId: string): Worker | undefined {
    return this.active.get(pluginId)?.bridge.getWorker()
  }

  /**
   * Plan C — invoke a hook in the named plugin's worker. Wraps
   * `bridge.callHook` and refreshes the per-plugin `lastActivityAt` so the
   * idle sweeper does not evict the plugin mid-chain. The caller (orchestrator)
   * is responsible for setting hook context on the bridge first.
   *
   * Throws (via the returned promise) when the plugin is not active, when the
   * worker reports an error, or when the supplied AbortSignal fires.
   */
  async invokeHook(
    pluginId: string,
    hook: HookName,
    args: {
      taskId: string
      signal: AbortSignal
      timeoutMs: number
      ctxPayload?: Record<string, unknown>
      metadataSnapshot?: Record<string, unknown>
    }
  ): Promise<void> {
    const a = this.active.get(pluginId)
    if (!a) {
      throw new AppError(
        ErrorCode.PluginRuntimeFault,
        `plugin ${pluginId} is not active`
      )
    }
    a.lastActivityAt = Date.now()
    await a.bridge.callHook(
      hook,
      args.taskId,
      args.signal,
      args.timeoutMs,
      args.ctxPayload,
      args.metadataSnapshot
    )
  }

  /**
   * Plan C — permanently disable a plugin (e.g. circuit breaker tripped).
   * Records the reason via the state store, marks the plugin disabled, and
   * tears down the active VM if one is running. Idempotent: calling on an
   * already-disabled plugin is a no-op besides updating `lastError`.
   */
  async disable(pluginId: string, reason: string): Promise<void> {
    this.opts.stateStore.setEnabled(pluginId, false)
    this.opts.stateStore.recordError(pluginId, reason)
    if (this.active.has(pluginId)) {
      await this.deactivate(pluginId)
    }
    this.opts.stateStore.setStatus(pluginId, 'disabled')
    this.opts.registry.refreshState(pluginId)
  }

  async shutdown(): Promise<void> {
    this.unsubscribeLocale()
    if (this.idleTimer) clearInterval(this.idleTimer)
    await Promise.all([...this.active.keys()].map((id) => this.deactivate(id)))
  }

  private sweepIdle(): void {
    const now = Date.now()
    for (const [id, a] of this.active.entries()) {
      if (now - a.lastActivityAt >= this.idleDisposeMs) {
        void this.deactivate(id)
      }
    }
  }

  /**
   * Exposed for unit tests so they can drive idle disposal without waiting
   * for the 30s timer interval.
   */
  __sweepIdleForTest(): void {
    this.sweepIdle()
  }

  /** Test helper: idle threshold accessor. */
  get idleDisposeMsForTest(): number {
    return this.idleDisposeMs
  }
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * Return the "highest" (most critical) role band contributed by the manifest.
 * Priority order (least critical first): audit, enrich, post-process, resolve,
 * pre-resolve. A plugin contributing multiple hooks at different tiers is
 * assigned the tier of its most critical hook so it is protected from eviction
 * at a tier below that threshold.
 *
 * Plugins with no hooks (commands-only) return 'audit' — the least critical
 * tier and therefore the first eviction bucket. T15 will replace this with
 * real in-flight tracking once TaskManager wires the orchestrator.
 */
export function deriveEvictionTier(
  manifest: PluginManifest
): ActiveMeta['evictionTier'] {
  const hooks = manifest.contributes.hooks ?? {}
  const roles = new Set<string>()
  for (const h of Object.values(hooks)) {
    roles.add(h.role ?? 'enrich')
  }
  if (roles.has('pre-resolve')) return 'pre-resolve'
  if (roles.has('resolve')) return 'resolve'
  if (roles.has('post-process')) return 'post-process'
  if (roles.has('enrich')) return 'enrich'
  return 'audit'
}
