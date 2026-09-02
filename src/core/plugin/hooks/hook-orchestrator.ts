// src/core/plugin/hooks/hook-orchestrator.ts
// Plan C — drives every hook chain:
//   - beforeCreate / beforeFinalize: serial chain over eligible plugins,
//     sorted by role band. Each plugin contributes via the StagedEffectStore;
//     the orchestrator merges patches at chain end and returns the result for
//     the caller (TaskManager) to commit atomically.
//   - afterComplete / onError: parallel fire-and-forget. Each plugin runs in
//     isolation; one plugin's failure does not affect the others.
//
// Fail-mode rules (per spec §10):
//   - resolve / pre-resolve / post-process throwing -> chain aborts (fail-closed).
//     The caller treats the task as not-created or not-finalized.
//   - enrich / audit throwing -> chain continues (fail-open with isolation).
//     The throwing plugin's staged effects are dropped via removeFromPlugin so
//     they cannot poison the merged result.
//
// Architecture contract:
//   - MUST NOT import from electron, @main/, @server/, @renderer/.
//   - Cooperates with PluginHost, CapabilityBridge, and the Plan C support
//     modules under @core/plugin/hooks/.

import { getLogger } from '@core/logger'
import type {
  AfterCompleteContextDTO,
  BeforeCreateHttpContextDTO,
  BeforeFinalizeContextDTO,
  OnErrorContextDTO,
} from '@shared/types/plugin-hooks'
import type { CapabilityHost } from '../capabilities/interface'
import type { ActivationDispatcher } from '../host/activation-dispatcher'
import type { ActivePluginInfo, PluginHost } from '../host/plugin-host'
import { newHookAbort } from './abort'
import type { HookAuditLog } from './audit-log'
import { sanitizeForAudit } from './audit-view'
import { type MergedHttp, mergeChain } from './chain-merge'
import { isEligible } from './eligibility'
import { isMostCritical, type RoleBand, sortByBand } from './role-band'
import { StagedEffectStore } from './staged-effects'
import { FfmpegStaging } from './staging-dir'

const log = getLogger('plugin:orchestrator')

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SeriesHook = 'beforeCreate' | 'beforeFinalize'
export type ParallelHook = 'afterComplete' | 'onError'
export type AnyHook = SeriesHook | ParallelHook

export interface CircuitBreaker {
  success(pluginId: string, hook: AnyHook): void
  failure(pluginId: string, hook: AnyHook): void
  isOpen(pluginId: string, hook: AnyHook): boolean
}

export interface OrchestratorOptions {
  host: PluginHost
  /** Registry-backed discovery and demand activation. Required in production. */
  activationDispatcher?: Pick<
    ActivationDispatcher,
    'candidatesForHook' | 'activateForHook'
  >
  hookTimeoutMs: { series: number; parallel: number }
  /** Root directory under which `<pluginId>/staging/<taskId>/` lives. */
  pluginsDir: string
  /** Returns the plugin's storage root; orchestrator passes it to the bridge. */
  pluginStorageRootFor: (pluginId: string) => string
  /** Production task-filesystem and metadata context for every Hook. */
  capabilityHost?: Pick<CapabilityHost, 'fsTaskFor' | 'metadata'>
  /** ffmpeg per-(plugin, task) staging quota in bytes. */
  ffmpegStagingQuotaBytes?: number
  /** Optional NDJSON audit log; T15 wires the real instance. */
  auditLog?: HookAuditLog
  /** Optional circuit breaker; T16 wires the real instance. */
  breaker?: CircuitBreaker
}

export interface BeforeCreateHttpResult {
  aborted?: false
  /** Merged DTO ready for engine handoff. */
  final: BeforeCreateHttpContextDTO
  /** Plugin attribution for the final headers / proxy / uris choices. */
  contributors: MergedHttp['contributors']
  /** Caller (TaskManager) commits this store inside its DB transaction. */
  staged: StagedEffectStore
}

export interface BeforeFinalizeResult {
  aborted?: false
  /** Original DTO plus the chain-decided filePath (if any plugin set it). */
  final: BeforeFinalizeContextDTO
  /** Path requested by the last resolve/post-process plugin to set finalizePath. */
  finalFilePath?: string
  /** Invocation-private replacement mapping; the finalizer verifies identity. */
  replacement?: { pluginId: string; stagedPath: string }
  staged: StagedEffectStore
}

export interface ChainAborted {
  aborted: true
  reason: string
}

// ---------------------------------------------------------------------------
// Internal — per-plugin chain entry
// ---------------------------------------------------------------------------

interface ChainEntry {
  id: string
  role: RoleBand
  info: ActivePluginInfo
}

function roleFromManifest(
  info: ActivePluginInfo,
  hook: AnyHook
): RoleBand | undefined {
  const decl = info.manifest.contributes.hooks?.[hook]
  if (!decl) return undefined
  const raw = decl.role
  if (
    raw === 'pre-resolve' ||
    raw === 'resolve' ||
    raw === 'enrich' ||
    raw === 'post-process' ||
    raw === 'audit'
  ) {
    return raw
  }
  // Default band when manifest omits role: enrich (least privileged mutator).
  return 'enrich'
}

// ---------------------------------------------------------------------------
// HookOrchestrator
// ---------------------------------------------------------------------------

export class HookOrchestrator {
  constructor(private readonly opts: OrchestratorOptions) {}

  // -------------------------------------------------------------------------
  // beforeCreate (HTTP)
  // -------------------------------------------------------------------------

  async runBeforeCreateHttp(
    initial: BeforeCreateHttpContextDTO,
    taskId: string
  ): Promise<BeforeCreateHttpResult | ChainAborted> {
    const chain = await this.eligiblePlugins(
      'beforeCreate',
      initial.uris[0],
      initial.type
    )
    log.info(
      {
        taskId,
        url: initial.uris[0],
        chainLength: chain.length,
        chain: chain.map((e) => ({ id: e.id, role: e.role })),
      },
      'runBeforeCreateHttp: eligible chain built'
    )
    if (chain.length === 0) {
      return {
        final: initial,
        contributors: { headers: [] },
        staged: new StagedEffectStore(),
      }
    }

    const staged = new StagedEffectStore()
    const timeout = this.opts.hookTimeoutMs.series
    let working = cloneBeforeCreate(initial)

    for (const entry of chain) {
      if (this.opts.breaker?.isOpen(entry.id, 'beforeCreate')) {
        // Breaker open — skip this plugin entirely. Treated like fail-open:
        // resolve/post-process being skipped is a host policy decision, not a
        // plugin failure, so the chain continues regardless of band.
        await this.opts.auditLog?.log({
          type: 'chain.skip',
          hook: 'beforeCreate',
          taskId,
          pluginId: entry.id,
          reason: 'breaker_open',
        })
        continue
      }

      const abort = newHookAbort(entry.info.bridge, entry.info.worker, timeout)

      try {
        const metadataSnapshot = await this.metadataSnapshot(taskId, entry.id)
        await this.opts.host.invokeHook(entry.id, 'beforeCreate', {
          taskId,
          signal: abort.signal,
          timeoutMs: timeout,
          ctxPayload: cloneBeforeCreate(working),
          metadataSnapshot,
          context: {
            fsTaskHost: STUB_FS_TASK_HOST,
            taskId,
            phase: 'beforeCreate',
            staged,
            role: entry.role,
            saveDir: working.saveDir,
            pluginStorageRoot: this.opts.pluginStorageRootFor(entry.id),
          },
        })
        working = mergeBeforeCreateWorking(initial, staged)
        this.opts.breaker?.success(entry.id, 'beforeCreate')
      } catch (e) {
        this.opts.breaker?.failure(entry.id, 'beforeCreate')
        await this.maybeDisable(entry.id, 'beforeCreate')
        const message = (e as Error).message
        await this.opts.auditLog?.log({
          type: 'chain.plugin_error',
          hook: 'beforeCreate',
          taskId,
          pluginId: entry.id,
          role: entry.role,
          error: message,
        })

        if (isMostCritical(entry.role)) {
          await this.opts.auditLog?.log({
            type: 'chain.abort',
            hook: 'beforeCreate',
            taskId,
            pluginId: entry.id,
            role: entry.role,
            reason: message,
          })
          return { aborted: true, reason: `${entry.id}: ${message}` }
        }
        // fail-open with isolation: drop this plugin's partial effects so the
        // merge step does not pick them up.
        staged.removeFromPlugin(entry.id)
        working = mergeBeforeCreateWorking(initial, staged)
      }
    }

    // Merge chain — produces the final headers/uris/proxy/filename plus
    // attribution. We feed mergeChain the staged patches with the user input
    // taken from `initial`.
    const merged = mergeChain(
      {
        uris: [...initial.uris],
        filename: initial.filename,
        connections: initial.connections,
        headers: initial.headers.map((h) => ({ name: h.name, value: h.value })),
        proxy: initial.proxy,
      },
      staged.allHttpPatches()
    )

    const final: BeforeCreateHttpContextDTO = {
      ...initial,
      uris: merged.uris,
      filename: merged.filename,
      connections: merged.connections,
      headers: merged.headers,
      proxy: merged.proxy,
    }

    await this.opts.auditLog?.log({
      type: 'chain.commit',
      hook: 'beforeCreate',
      taskId,
      contributors: merged.contributors,
    })

    return { final, contributors: merged.contributors, staged }
  }

  // -------------------------------------------------------------------------
  // beforeFinalize
  // -------------------------------------------------------------------------

  async runBeforeFinalize(
    initial: BeforeFinalizeContextDTO,
    taskId: string
  ): Promise<BeforeFinalizeResult | ChainAborted> {
    const chain = await this.eligiblePlugins(
      'beforeFinalize',
      undefined,
      initial.task.type
    )
    if (chain.length === 0) {
      return {
        final: initial,
        finalFilePath: undefined,
        staged: new StagedEffectStore(),
      }
    }

    const staged = new StagedEffectStore()
    const timeout = this.opts.hookTimeoutMs.series
    let working = cloneBeforeFinalize(initial)

    for (const entry of chain) {
      if (this.opts.breaker?.isOpen(entry.id, 'beforeFinalize')) {
        await this.opts.auditLog?.log({
          type: 'chain.skip',
          hook: 'beforeFinalize',
          taskId,
          pluginId: entry.id,
          reason: 'breaker_open',
        })
        continue
      }

      const abort = newHookAbort(entry.info.bridge, entry.info.worker, timeout)

      // beforeFinalize uses the saveDir derived from initial.filePath's parent
      // for path-escape validation (T3 validateFinalizePatch). The bridge gate
      // also needs a non-null fsTaskHost for the matrix branch.
      const saveDir = initial.task.saveDir
      // Per-plugin ffmpeg staging dir. PR-2 Task 4: orchestrator owns the
      // lifecycle because both taskId and pluginId are in scope here. The
      // bridge enforces the staging-only ffmpeg saveDir write contract; this
      // store-side record lets Task 5 promote one staging and discard the rest
      // on chain commit. quotaBytes default mirrors spec §2.1 (4 GiB);
      // MediaSettings wiring (PR-4) will inject the user-configured value.
      const staging = new FfmpegStaging({
        pluginsDir: this.opts.pluginsDir,
        taskId,
        pluginId: entry.id,
        saveDir,
        quotaBytes: this.opts.ffmpegStagingQuotaBytes ?? 4 * 1024 ** 3,
      })
      staged.appendStaging(entry.id, staging)
      const previousFinalizePath = staged.pendingFinalizePath

      try {
        const metadataSnapshot = await this.metadataSnapshot(taskId, entry.id)
        await this.opts.host.invokeHook(entry.id, 'beforeFinalize', {
          taskId,
          signal: abort.signal,
          timeoutMs: timeout,
          ctxPayload: cloneBeforeFinalize(working),
          metadataSnapshot,
          context: {
            fsTaskHost:
              this.opts.capabilityHost?.fsTaskFor(
                initial.task.saveDir,
                initial.inputFilePath
              ) ?? STUB_FS_TASK_HOST,
            taskId,
            phase: 'beforeFinalize',
            staged,
            role: entry.role,
            saveDir,
            pluginStorageRoot: this.opts.pluginStorageRootFor(entry.id),
            staging,
          },
        })
        const nextTarget = staged.pendingFinalizePath
        if (nextTarget !== undefined) {
          working = {
            ...working,
            filePath: nextTarget,
            targetFilePath: nextTarget,
          }
        }
        this.opts.breaker?.success(entry.id, 'beforeFinalize')
      } catch (e) {
        this.opts.breaker?.failure(entry.id, 'beforeFinalize')
        await this.maybeDisable(entry.id, 'beforeFinalize')
        const message = (e as Error).message
        await this.opts.auditLog?.log({
          type: 'chain.plugin_error',
          hook: 'beforeFinalize',
          taskId,
          pluginId: entry.id,
          role: entry.role,
          error: message,
        })

        if (isMostCritical(entry.role)) {
          await this.opts.auditLog?.log({
            type: 'chain.abort',
            hook: 'beforeFinalize',
            taskId,
            pluginId: entry.id,
            role: entry.role,
            reason: message,
          })
          return { aborted: true, reason: `${entry.id}: ${message}` }
        }
        staged.removeFromPlugin(entry.id)
        staged.restoreFinalizePath(previousFinalizePath)
        working = {
          ...working,
          filePath: previousFinalizePath ?? initial.filePath,
          targetFilePath: previousFinalizePath ?? initial.targetFilePath,
        }
      }
    }

    const finalFilePath = staged.pendingFinalizePath
    const final = cloneBeforeFinalize(working)

    // The orchestrator only returns a logical-to-private mapping. The finalize
    // committer owns identity, journal, no-replace install, and cleanup.
    const stagings = staged.takeAllStagings()
    const replacements: Array<{ pluginId: string; stagedPath: string }> = []
    for (const { pluginId, staging } of stagings) {
      if (!finalFilePath) continue
      const stagedPath = staging.mappedArtifact(finalFilePath)
      if (stagedPath) replacements.push({ pluginId, stagedPath })
    }
    if (replacements.length > 1) {
      return {
        aborted: true,
        reason: 'multiple plugins selected the same finalize replacement',
      }
    }
    const replacement = replacements[0]

    await this.opts.auditLog?.log({
      type: 'chain.commit',
      hook: 'beforeFinalize',
      taskId,
      finalFilePath: final.filePath,
      stagingPromoted: false,
      stagingPluginId: replacement?.pluginId,
      stagingBytesPromoted: 0,
      stagingBytesDiscarded: 0,
    })

    return { final, finalFilePath, replacement, staged }
  }

  // -------------------------------------------------------------------------
  // afterComplete / onError — parallel
  // -------------------------------------------------------------------------

  async runParallel(
    hook: ParallelHook,
    ctxDto: AfterCompleteContextDTO | OnErrorContextDTO,
    taskId: string
  ): Promise<void> {
    const chain = await this.eligiblePlugins(hook)
    if (chain.length === 0) return

    const timeout = this.opts.hookTimeoutMs.parallel

    const work = chain.map(async (entry) => {
      if (this.opts.breaker?.isOpen(entry.id, hook)) {
        await this.opts.auditLog?.log({
          type: 'chain.skip',
          hook,
          taskId,
          pluginId: entry.id,
          reason: 'breaker_open',
        })
        return
      }

      const abort = newHookAbort(entry.info.bridge, entry.info.worker, timeout)

      try {
        const metadataSnapshot = await this.metadataSnapshot(taskId, entry.id)
        await this.opts.host.invokeHook(entry.id, hook, {
          taskId,
          signal: abort.signal,
          timeoutMs: timeout,
          ctxPayload: { ...ctxDto },
          metadataSnapshot,
          context: {
            fsTaskHost:
              this.opts.capabilityHost?.fsTaskFor(
                ctxDto.task.saveDir,
                ctxDto.filePath
              ) ?? STUB_FS_TASK_HOST,
            taskId,
          },
        })
        this.opts.breaker?.success(entry.id, hook)
      } catch (e) {
        this.opts.breaker?.failure(entry.id, hook)
        await this.maybeDisable(entry.id, hook)
        await this.opts.auditLog?.log({
          type: 'chain.plugin_error',
          hook,
          taskId,
          pluginId: entry.id,
          role: entry.role,
          error: (e as Error).message,
        })
      }
    })

    await Promise.allSettled(work)
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Internal — collect every active plugin whose manifest declares the hook
   * and (for before* hooks) whose hostPermissions accept the task URL. Result
   * is sorted by role band ascending so the chain runs resolve before enrich
   * before audit.
   */
  private async eligiblePlugins(
    hook: AnyHook,
    url?: string,
    taskType?: 'http' | 'bt' | 'magnet' | 'ftp' | 'metalink'
  ): Promise<ChainEntry[]> {
    const out: ChainEntry[] = []
    const descriptors = this.opts.activationDispatcher?.candidatesForHook(
      hook,
      {
        taskUrl: url,
        taskType,
      }
    )
    if (descriptors) {
      for (const descriptor of descriptors) {
        await this.opts.activationDispatcher?.activateForHook(
          descriptor.id,
          hook
        )
        const info = this.opts.host
          .allActive()
          .find((active) => active.id === descriptor.id)
        if (!info) {
          throw new Error(
            `hook demand activation completed without active plugin ${descriptor.id}`
          )
        }
        const role = roleFromManifest(info, hook)
        if (role) out.push({ id: info.id, role, info })
      }
      return sortByBand(
        out.map((entry) => ({
          pluginId: entry.id,
          role: entry.role,
          info: entry.info,
        }))
      ).map((entry) => ({
        id: entry.pluginId,
        role: entry.role,
        info: entry.info,
      }))
    }

    const active = this.opts.host.allActive()
    log.debug(
      {
        hook,
        url,
        activeCount: active.length,
        activeIds: active.map((p) => p.id),
      },
      'eligiblePlugins: scanning active plugins'
    )
    for (const info of active) {
      const eligible = isEligible({
        manifest: info.manifest,
        hook,
        taskUrl: url,
      })
      const role = eligible ? roleFromManifest(info, hook) : undefined
      log.debug(
        {
          pluginId: info.id,
          hook,
          url,
          hasHook: Boolean(info.manifest.contributes.hooks?.[hook]),
          hostPermissions: info.manifest.hostPermissions ?? [],
          eligible,
          role,
        },
        'eligiblePlugins: per-plugin decision'
      )
      if (!eligible) continue
      if (!role) continue
      out.push({ id: info.id, role, info })
    }
    return sortByBand(
      out.map((e) => ({ pluginId: e.id, role: e.role, info: e.info }))
    ).map((e) => ({ id: e.pluginId, role: e.role, info: e.info }))
  }

  /**
   * If the breaker has tripped for (pluginId, hook), evict the plugin via
   * host.disable so subsequent chains skip it entirely. Swallows disable
   * failures (e.g. state store I/O errors) so a hung disable cannot bubble
   * up and break the running hook chain's fail-mode handling.
   */
  private async maybeDisable(pluginId: string, hook: AnyHook): Promise<void> {
    if (!this.opts.breaker?.isOpen(pluginId, hook)) return
    try {
      await this.opts.host.disable(pluginId, 'circuit_open')
    } catch {
      // disable failed (state store unreachable, etc.); intentionally
      // swallowed — the breaker keeps the plugin closed for future chains
      // and the chain's own fail-mode handling continues normally.
    }
  }

  private metadataSnapshot(
    taskId: string,
    pluginId: string
  ): Promise<Record<string, unknown>> {
    return (
      this.opts.capabilityHost?.metadata.getAll(taskId, pluginId) ??
      Promise.resolve({})
    )
  }

  /**
   * Plan C surface for tests / T6 audit-view callers that need to construct
   * the sanitized DTO for an audit-role plugin's ctx. Re-exported from the
   * audit-view module so test code does not have to drill into both files.
   */
  static audit = sanitizeForAudit
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Unit-test fallback. Production assembly always supplies capabilityHost. */
type FsTaskHost = ReturnType<CapabilityHost['fsTaskFor']>

const STUB_FS_TASK_HOST: FsTaskHost = {
  stat: () => notWired('fs.task.stat'),
  exists: () => notWired('fs.task.exists'),
  computeHash: () => notWired('fs.task.computeHash'),
  rename: () => notWired('fs.task.rename'),
  openReader: () => notWired('fs.task.openReader'),
} as unknown as FsTaskHost

function notWired(method: string): never {
  const e: Error & { code?: string } = new Error(
    `${method} not wired by orchestrator yet (deferred to T15)`
  )
  e.code = 'plugin.fs.task.not_wired'
  throw e
}

function cloneBeforeCreate(
  value: BeforeCreateHttpContextDTO
): BeforeCreateHttpContextDTO {
  return {
    ...value,
    uris: [...value.uris],
    headers: value.headers.map((header) => ({ ...header })),
  }
}

function mergeBeforeCreateWorking(
  initial: BeforeCreateHttpContextDTO,
  staged: StagedEffectStore
): BeforeCreateHttpContextDTO {
  const merged = mergeChain(
    {
      uris: [...initial.uris],
      filename: initial.filename,
      connections: initial.connections,
      headers: initial.headers.map((header) => ({ ...header })),
      proxy: initial.proxy,
    },
    staged.allHttpPatches()
  )
  return {
    ...initial,
    uris: merged.uris,
    filename: merged.filename,
    connections: merged.connections,
    headers: merged.headers,
    proxy: merged.proxy,
  }
}

function cloneBeforeFinalize(
  value: BeforeFinalizeContextDTO
): BeforeFinalizeContextDTO {
  return {
    ...value,
    task: {
      ...value.task,
      error: value.task.error
        ? {
            ...value.task.error,
            detailParams: value.task.error.detailParams
              ? { ...value.task.error.detailParams }
              : null,
          }
        : null,
    },
  }
}
