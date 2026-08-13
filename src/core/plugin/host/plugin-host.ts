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
  /** Injectable bundle-source reader; defaults to `readFile(path, 'utf8')`. */
  readBundleSource?: (bundlePath: string) => Promise<string>
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
  /** Shared teardown promise so fatal/deactivate races cannot dispose twice. */
  teardown?: Promise<void>
  /** A failed dispose() must retry the worker termination backstop directly. */
  disposeNeedsBackstop?: boolean
  /**
   * Snapshot taken at activation time. `true` when the plugin does not
   * declare ffmpeg at all (vacuously satisfied), or when detection met the
   * declared `engines.ffmpeg` range. `false` only when the plugin declares
   * `optionalPermissions: ['ffmpeg']` and detection was missing or below
   * range (required+miss always throws before this field is stored).
   */
  ffmpegAdvertised: boolean
}

interface ActivationAttempt {
  epoch: number
  cancelled: boolean
  cancellation: Promise<never>
  cancel(): void
  promise: Promise<void>
}

/**
 * Default soft cap on concurrently-active plugins, shared by PluginHost and
 * ActivationDispatcher so their independent defaults can't silently diverge.
 */
export const DEFAULT_MAX_ACTIVE_PLUGINS = 32

export class PluginHost {
  private readonly active = new Map<string, Active>()
  // Per-plugin activation/deactivation state. The epoch invalidates every
  // await continuation from an older activation, while `quiescing` is a
  // synchronous tombstone that prevents a replacement worker from starting
  // until teardown has fully completed.
  private readonly activating = new Map<string, ActivationAttempt>()
  private readonly deactivating = new Map<string, Promise<void>>()
  private readonly activationEpochs = new Map<string, number>()
  private readonly quiescing = new Set<string>()
  private readonly maxActivePlugins: number
  private readonly idleDisposeMs: number
  private readonly activationTimeoutMs: number
  private readonly deactivateBudgetMs: number
  private idleTimer?: NodeJS.Timeout
  private unsubscribeLocale: () => void = () => {}
  private shuttingDown = false

  constructor(private readonly opts: PluginHostOptions) {
    this.maxActivePlugins = opts.maxActivePlugins ?? DEFAULT_MAX_ACTIVE_PLUGINS
    // Spec §7 L2149 — Plugin Active → 5 min no hook/capability/timer activity
    // → dispose VM → Inactive. Shells may inject an operations override.
    this.idleDisposeMs = opts.idleDisposeMs ?? 5 * 60_000
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
      if (this.quiescing.has(pluginId)) continue
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
    return this.active.has(pluginId) && !this.quiescing.has(pluginId)
  }

  /**
   * True only when no worker, bridge, activation continuation, or teardown
   * remains for the plugin. Installer commit/uninstall use this stronger
   * postcondition instead of treating an early `active.delete()` as stopped.
   */
  isQuiescent(pluginId: string): boolean {
    return (
      !this.active.has(pluginId) &&
      !this.activating.has(pluginId) &&
      !this.deactivating.has(pluginId) &&
      !this.quiescing.has(pluginId)
    )
  }

  /**
   * Whether the plugin's ffmpeg surface advertises as available. Reflects
   * the snapshot taken at activate time. Returns undefined when the plugin
   * is not active.
   */
  getFfmpegAdvertised(pluginId: string): boolean | undefined {
    return this.activeForUse(pluginId)?.ffmpegAdvertised
  }

  activeIds(): string[] {
    return [...this.active.keys()].filter((id) => !this.quiescing.has(id))
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
    const a = this.activeForUse(pluginId)
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
    if (this.shuttingDown) {
      throw new AppError(
        ErrorCode.PluginRuntimeFault,
        'plugin.activation.host_shutting_down'
      )
    }
    // Check the tombstone before `active`: the old worker remains owned by
    // `active` until dispose() completes, but must not be considered a valid
    // idempotent activation while teardown is underway.
    if (this.quiescing.has(pluginId)) {
      throw this.activationSupersededError(pluginId)
    }
    const inFlight = this.activating.get(pluginId)
    if (inFlight) return inFlight.promise
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
    const epoch = (this.activationEpochs.get(pluginId) ?? 0) + 1
    this.activationEpochs.set(pluginId, epoch)
    let rejectCancellation!: (error: Error) => void
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject
    })
    // The cancellation promise is raced at every async boundary. Keep a
    // handler attached even between those boundaries to avoid an unhandled
    // rejection when deactivate() wins immediately.
    void cancellation.catch(() => undefined)
    const attempt: ActivationAttempt = {
      epoch,
      cancelled: false,
      cancellation,
      cancel: () => {
        if (attempt.cancelled) return
        attempt.cancelled = true
        rejectCancellation(this.activationSupersededError(pluginId))
      },
      promise: Promise.resolve(),
    }
    // Start in a microtask so the attempt and its real promise are both
    // published before registry/capability test doubles can re-enter us.
    const promise = Promise.resolve()
      .then(() => this.doActivate(pluginId, attempt))
      .finally(() => {
        if (this.activating.get(pluginId) === attempt) {
          this.activating.delete(pluginId)
        }
      })
    attempt.promise = promise
    this.activating.set(pluginId, attempt)
    return promise
  }

  private async doActivate(
    pluginId: string,
    attempt: ActivationAttempt
  ): Promise<void> {
    this.assertActivationCurrent(pluginId, attempt)
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
      ffmpegDetection = await this.awaitActivation(
        pluginId,
        attempt,
        this.opts.ffmpegDetect()
      )
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
      const moextBytes = await this.awaitActivation(
        pluginId,
        attempt,
        readFile(path.join(indexed.rootDir, 'bundle.moext'))
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
      const entryBytes = await this.awaitActivation(
        pluginId,
        attempt,
        readMoextEntry(moextBytes, indexed.manifest.main)
      )
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
      const readBundleSource =
        this.opts.readBundleSource ?? ((file) => readFile(file, 'utf8'))
      bundleSource = await this.awaitActivation(
        pluginId,
        attempt,
        readBundleSource(bundlePath)
      )
    }

    let resolveReady: () => void
    let rejectReady: (e: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })

    const effectivePermissions = this.opts.pluginGrants
      ? await this.awaitActivation(
          pluginId,
          attempt,
          this.opts.pluginGrants.effectivePermissionsFor(pluginId)
        )
      : undefined

    this.assertActivationCurrent(pluginId, attempt)
    let bridge: CapabilityBridge | undefined
    bridge = new CapabilityBridge(
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
          if (
            !bridge ||
            !this.isActivationCurrent(pluginId, attempt) ||
            this.active.get(pluginId)?.bridge !== bridge
          ) {
            return
          }
          this.opts.stateStore.markActivated(pluginId, Date.now())
          this.opts.registry.refreshState(pluginId)
          resolveReady()
        },
        onRegister: (kind, key) => {
          const current = this.active.get(pluginId)
          if (
            bridge &&
            current?.bridge === bridge &&
            !this.quiescing.has(pluginId)
          ) {
            current.registrations.push({ kind, key })
          }
        },
        onFatal: (code, message) => {
          if (
            !bridge ||
            this.active.get(pluginId)?.bridge !== bridge ||
            this.quiescing.has(pluginId)
          ) {
            return
          }
          this.opts.stateStore.recordError(pluginId, `${code}: ${message}`)
          this.opts.registry.refreshState(pluginId)
          rejectReady(new AppError(ErrorCode.PluginRuntimeFault, message))
          void this.deactivate(pluginId).catch(() => undefined)
        },
      }
    )
    this.assertActivationCurrent(pluginId, attempt)
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
      await this.awaitActivation(
        pluginId,
        attempt,
        Promise.race([ready, timeoutP])
      )
    } catch (e) {
      const current = this.active.get(pluginId)
      if (bridge && current?.bridge === bridge) {
        await this.teardownActive(pluginId, current)
      } else if (bridge) {
        await bridge.dispose()
      }
      throw e
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }

  async deactivate(pluginId: string): Promise<void> {
    const existing = this.deactivating.get(pluginId)
    if (existing) return existing

    // Establish the tombstone and supersede the activation synchronously,
    // before yielding to any continuation that could publish a bridge.
    this.quiescing.add(pluginId)
    this.activationEpochs.set(
      pluginId,
      (this.activationEpochs.get(pluginId) ?? 0) + 1
    )
    const attempt = this.activating.get(pluginId)
    attempt?.cancel()

    const promise = Promise.resolve()
      .then(() => this.doDeactivate(pluginId, attempt))
      .finally(() => {
        if (this.deactivating.get(pluginId) === promise) {
          this.deactivating.delete(pluginId)
          this.quiescing.delete(pluginId)
        }
      })
    this.deactivating.set(pluginId, promise)
    return promise
  }

  private async doDeactivate(
    pluginId: string,
    attempt: ActivationAttempt | undefined
  ): Promise<void> {
    // The attempt rejects when cancellation wins. Its catch path owns cleanup
    // for any bridge it managed to create, so wait for that path before
    // checking the stable active entry below.
    await attempt?.promise.catch(() => undefined)
    const active = this.active.get(pluginId)
    if (active) await this.teardownActive(pluginId, active)
  }

  private teardownActive(pluginId: string, active: Active): Promise<void> {
    if (active.teardown) return active.teardown
    let teardown!: Promise<void>
    teardown = this.performTeardown(pluginId, active).catch((error) => {
      // A rejected teardown must not be cached forever. Keep the active entry
      // owned by the host and let a later deactivate/upgrade retry termination.
      if (active.teardown === teardown) active.teardown = undefined
      throw error
    })
    active.teardown = teardown
    return teardown
  }

  private async performTeardown(
    pluginId: string,
    active: Active
  ): Promise<void> {
    // 1. Run worker-side deactivate handlers (budget enforced by bridge).
    try {
      await active.bridge.runDeactivate(this.deactivateBudgetMs)
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

    // 3. Tear down bridge and mark inactive. CapabilityBridge marks itself
    // disposed before awaiting Worker.terminate(), so a rejected dispose()
    // cannot itself be retried; terminate the worker directly as a backstop.
    await this.disposeActiveBridge(pluginId, active)
    if (this.active.get(pluginId) === active) {
      this.active.delete(pluginId)
    }
    this.opts.stateStore.setStatus(pluginId, 'inactive')
    this.opts.registry.refreshState(pluginId)
  }

  private async disposeActiveBridge(
    pluginId: string,
    active: Active
  ): Promise<void> {
    if (!active.disposeNeedsBackstop) {
      try {
        await active.bridge.dispose()
        return
      } catch (error) {
        active.disposeNeedsBackstop = true
        this.opts.capabilityHost
          .createLog(pluginId)
          .warn('worker bridge dispose failed; terminating worker directly', {
            error: (error as Error).message,
            code: (error as Error & { code?: string }).code,
          })
      }
    }

    try {
      await active.bridge.getWorker().terminate()
      active.disposeNeedsBackstop = false
    } catch (error) {
      this.opts.capabilityHost
        .createLog(pluginId)
        .warn('worker terminate backstop failed', {
          error: (error as Error).message,
          code: (error as Error & { code?: string }).code,
        })
      throw error
    }
  }

  private async awaitActivation<T>(
    pluginId: string,
    attempt: ActivationAttempt,
    operation: PromiseLike<T>
  ): Promise<T> {
    const value = await Promise.race([
      Promise.resolve(operation),
      attempt.cancellation,
    ])
    this.assertActivationCurrent(pluginId, attempt)
    return value
  }

  private isActivationCurrent(
    pluginId: string,
    attempt: ActivationAttempt
  ): boolean {
    return (
      !attempt.cancelled &&
      !this.quiescing.has(pluginId) &&
      this.activationEpochs.get(pluginId) === attempt.epoch &&
      this.activating.get(pluginId) === attempt
    )
  }

  private assertActivationCurrent(
    pluginId: string,
    attempt: ActivationAttempt
  ): void {
    if (!this.isActivationCurrent(pluginId, attempt)) {
      throw this.activationSupersededError(pluginId)
    }
  }

  private activationSupersededError(pluginId: string): AppError {
    return new AppError(
      ErrorCode.PluginRuntimeFault,
      `plugin.activation.superseded: ${pluginId}`
    )
  }

  /**
   * Plan C — list every currently active plugin with the descriptors the
   * HookOrchestrator needs (manifest for eligibility/role, bridge for hook
   * invocation, worker for the abort backstop).
   */
  allActive(): ActivePluginInfo[] {
    const out: ActivePluginInfo[] = []
    for (const [id, a] of this.active.entries()) {
      if (this.quiescing.has(id)) continue
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
    return [...this.active.entries()]
      .filter(([id]) => !this.quiescing.has(id))
      .map(([id, a]) => ({
        id,
        lastActivityAt: a.lastActivityAt,
        idleMs: now - a.lastActivityAt,
        evictionTier: deriveEvictionTier(a.manifest),
      }))
  }

  /** Plan C — bridge accessor used by HookOrchestrator and tests. */
  bridgeFor(pluginId: string): CapabilityBridge | undefined {
    return this.activeForUse(pluginId)?.bridge
  }

  /** Plan C — worker accessor used by `newHookAbort` for the terminate path. */
  workerFor(pluginId: string): Worker | undefined {
    return this.activeForUse(pluginId)?.bridge.getWorker()
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
    const a = this.activeForUse(pluginId)
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
    if (!this.isQuiescent(pluginId)) {
      await this.deactivate(pluginId)
    }
    this.opts.stateStore.setStatus(pluginId, 'disabled')
    this.opts.registry.refreshState(pluginId)
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    this.unsubscribeLocale()
    if (this.idleTimer) clearInterval(this.idleTimer)
    const pluginIds = new Set([
      ...this.active.keys(),
      ...this.activating.keys(),
      ...this.deactivating.keys(),
    ])
    await Promise.all([...pluginIds].map((id) => this.deactivate(id)))
  }

  private sweepIdle(): void {
    const now = Date.now()
    for (const [id, a] of this.active.entries()) {
      if (this.quiescing.has(id)) continue
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

  private activeForUse(pluginId: string): Active | undefined {
    if (this.quiescing.has(pluginId)) return undefined
    return this.active.get(pluginId)
  }
}

export function parsePluginIdleDisposeMs(
  raw: string | undefined
): number | undefined {
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
