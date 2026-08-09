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

import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { getLogger } from '@core/logger'
import type {
  AfterCompleteContextDTO,
  BeforeCreateHttpContextDTO,
  BeforeFinalizeContextDTO,
  OnErrorContextDTO,
} from '@shared/types/plugin-hooks'
import type { CapabilityHost } from '../capabilities/interface'
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
  hookTimeoutMs: { series: number; parallel: number }
  /** Root directory under which `<pluginId>/staging/<taskId>/` lives. */
  pluginsDir: string
  /** Returns the plugin's storage root; orchestrator passes it to the bridge. */
  pluginStorageRootFor: (pluginId: string) => string
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
    const chain = this.eligiblePlugins('beforeCreate', initial.uris[0])
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

      // Set hook context BEFORE invocation: staged store, role, saveDir all
      // need to be live for ctx.update / metadata.set to be routed correctly
      // by the phase-matrix gate (T8).
      entry.info.bridge.setHookContext({
        // Plan C ships only the bare hook context for beforeCreate (no
        // fsTaskHost — fs.task is disallowed in beforeCreate per the matrix).
        // The bridge's setHookContext requires a non-null host for the Plan B
        // shape; we satisfy the type with a stub that throws if invoked. The
        // matrix gate fires before any dispatch reaches the host.
        fsTaskHost: STUB_FS_TASK_HOST,
        taskId,
        phase: 'beforeCreate',
        staged,
        role: entry.role,
        saveDir: initial.saveDir,
        pluginStorageRoot: this.opts.pluginStorageRootFor(entry.id),
      })

      try {
        await this.opts.host.invokeHook(entry.id, 'beforeCreate', {
          taskId,
          signal: abort.signal,
          timeoutMs: timeout,
          ctxPayload: {
            type: initial.type,
            sourceUrl: initial.sourceUrl,
            uris: [...initial.uris],
            saveDir: initial.saveDir,
            filename: initial.filename,
            connections: initial.connections,
            headers: initial.headers.map((h) => ({
              name: h.name,
              value: h.value,
            })),
            proxy: initial.proxy,
            createdBy: initial.createdBy,
            requestedAt: initial.requestedAt,
          },
        })
        this.opts.breaker?.success(entry.id, 'beforeCreate')
      } catch (e) {
        this.opts.breaker?.failure(entry.id, 'beforeCreate')
        await this.maybeDisable(entry.id, 'beforeCreate')
        entry.info.bridge.clearHookContext()
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
        continue
      }
      entry.info.bridge.clearHookContext()
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
    const chain = this.eligiblePlugins('beforeFinalize', initial.sourceUrl)
    if (chain.length === 0) {
      return {
        final: initial,
        finalFilePath: undefined,
        staged: new StagedEffectStore(),
      }
    }

    const staged = new StagedEffectStore()
    const timeout = this.opts.hookTimeoutMs.series

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
      const saveDir = parentDirOf(initial.filePath)
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
      entry.info.bridge.setHookContext({
        fsTaskHost: STUB_FS_TASK_HOST,
        taskId,
        phase: 'beforeFinalize',
        staged,
        role: entry.role,
        saveDir,
        pluginStorageRoot: this.opts.pluginStorageRootFor(entry.id),
        staging,
      })

      try {
        await this.opts.host.invokeHook(entry.id, 'beforeFinalize', {
          taskId,
          signal: abort.signal,
          timeoutMs: timeout,
        })
        this.opts.breaker?.success(entry.id, 'beforeFinalize')
      } catch (e) {
        this.opts.breaker?.failure(entry.id, 'beforeFinalize')
        await this.maybeDisable(entry.id, 'beforeFinalize')
        entry.info.bridge.clearHookContext()
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
          // Discard every in-flight staging before aborting. Per spec §3.3 the
          // orchestrator owns this cleanup — callers must not see partial bytes
          // in <pluginsDir>/<pluginId>/staging/<taskId> after a chain abort.
          // A discard failure (EPERM/EROFS) must NOT escape this block: that
          // would replace the { aborted } result with a thrown rejection the
          // caller can't classify, and it could then finalize partial state.
          for (const { staging } of staged.takeAllStagings()) {
            try {
              await staging.discard()
            } catch (discardErr) {
              log.warn(
                { err: discardErr, taskId, pluginId: entry.id },
                'staging discard failed during chain abort; continuing'
              )
            }
          }
          return { aborted: true, reason: `${entry.id}: ${message}` }
        }
        staged.removeFromPlugin(entry.id)
        continue
      }
      entry.info.bridge.clearHookContext()
    }

    const finalFilePath = staged.pendingFinalizePath
    const final: BeforeFinalizeContextDTO = {
      ...initial,
      filePath: finalFilePath ?? initial.filePath,
    }

    // Drain the per-plugin stagings and decide which one (if any) gets
    // promoted to its final location in saveDir; discard the rest. Spec §3.3
    // mandates at most one promotion per chain — the staging whose dir
    // contains the final filePath wins; remaining stagings are discarded so
    // their bytes don't leak into the user's saveDir.
    const saveDirForCommit = parentDirOf(initial.filePath)
    const stagings = staged.takeAllStagings()
    let promotedPluginId: string | undefined
    let stagingBytesPromoted = 0
    let stagingBytesDiscarded = 0
    for (const { pluginId, staging } of stagings) {
      const owns =
        finalFilePath !== undefined &&
        promotedPluginId === undefined &&
        (await this.finalPathLivesUnderStaging(
          finalFilePath,
          staging,
          saveDirForCommit
        ))
      const bytes = await stagingTotalBytes(staging)
      if (owns) {
        await staging.promote(finalFilePath as string)
        promotedPluginId = pluginId
        stagingBytesPromoted = bytes
      } else {
        await staging.discard()
        stagingBytesDiscarded += bytes
      }
    }

    await this.opts.auditLog?.log({
      type: 'chain.commit',
      hook: 'beforeFinalize',
      taskId,
      finalFilePath: final.filePath,
      stagingPromoted: promotedPluginId !== undefined,
      stagingPluginId: promotedPluginId,
      stagingBytesPromoted,
      stagingBytesDiscarded,
    })

    return { final, finalFilePath, staged }
  }

  /**
   * Returns true when a file exists at `staging.dir + relative(saveDir,
   * finalFilePath)`. Used by the chain-commit logic to pick the single
   * staging whose contents include the path the chain selected as the final
   * download artefact (spec §3.3). When `finalFilePath` is outside `saveDir`,
   * the relative path is `..`-prefixed and no staging can own it.
   */
  private async finalPathLivesUnderStaging(
    finalFilePath: string,
    staging: FfmpegStaging,
    saveDir: string
  ): Promise<boolean> {
    const trimmedSaveDir = saveDir.replace(/[/\\]+$/, '')
    const rel = path.relative(trimmedSaveDir, finalFilePath)
    if (rel.startsWith('..')) return false
    const candidate = path.join(staging.dir, rel)
    try {
      await stat(candidate)
      return true
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // afterComplete / onError — parallel
  // -------------------------------------------------------------------------

  async runParallel(
    hook: ParallelHook,
    ctxDto: AfterCompleteContextDTO | OnErrorContextDTO,
    taskId: string
  ): Promise<void> {
    const chain = this.eligiblePlugins(hook)
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
      // Parallel hooks don't stage anything (ctx.update is disallowed by the
      // matrix outside before*); the Plan B-shaped context with fsTaskHost is
      // sufficient. fs.task is allowed for read-only inspection so we pass a
      // stub here; T15/T17 will wire the real per-task host when the orchestrator
      // is hooked into TaskManager.
      entry.info.bridge.setHookContext({
        fsTaskHost: STUB_FS_TASK_HOST,
        taskId,
      })

      try {
        await this.opts.host.invokeHook(entry.id, hook, {
          taskId,
          signal: abort.signal,
          timeoutMs: timeout,
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
      } finally {
        entry.info.bridge.clearHookContext()
      }
    })

    await Promise.allSettled(work)
    // ctxDto is currently unused — the worker reconstructs ctx from its own
    // registered handler signature. The parameter is retained so T15 can pipe
    // the DTO through for richer audit logging without an API change.
    void ctxDto
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
  private eligiblePlugins(hook: AnyHook, url?: string): ChainEntry[] {
    const out: ChainEntry[] = []
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

/**
 * STUB_FS_TASK_HOST — placeholder fs.task host injected during orchestrator
 * hook context setup. Plan C series hooks (beforeCreate) disallow every
 * fs.task method via the phase matrix, so this stub is never reached for
 * those phases. Plan C parallel hooks (afterComplete / onError) DO allow
 * read-only fs.task inspection, but real wiring is deferred to T15 when the
 * orchestrator gains access to the TaskManager's per-task host factory.
 *
 * Every method throws with a clear code so it is obvious in audit logs when
 * a plugin accidentally calls into the stub before T15 lands.
 */
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

function parentDirOf(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (idx <= 0) return '/'
  return p.slice(0, idx)
}

/**
 * Walks a FfmpegStaging directory tree and returns the total bytes of all
 * regular files within it. Returns 0 if the dir does not exist — callers use
 * this for audit-log accounting only, so a missing dir (already promoted /
 * discarded) is not an error.
 */
async function stagingTotalBytes(staging: FfmpegStaging): Promise<number> {
  try {
    const entries = await readdir(staging.dir, {
      recursive: true,
      withFileTypes: true,
    })
    let total = 0
    for (const e of entries) {
      if (e.isFile()) {
        const filePath = path.join(e.parentPath ?? staging.dir, e.name)
        total += (await stat(filePath)).size
      }
    }
    return total
  } catch {
    return 0
  }
}
