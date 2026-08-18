// src/core/plugin/host/capability-bridge.ts
// dispatch table for all Phase 1A capabilities; per-plugin scoping closures;
// ffmpeg op handle map; hook ctx slot for Plan C.
//
// Architecture contract:
//   - MUST NOT import electron, @main/, @server/.
//   - Receives BridgeCallMessage from the worker thread; routes to the
//     appropriate CapabilityHost member; returns BridgeResponseMessage.
//   - Per-plugin scoping: fs.storage, config, http (cookie jar) are lazily
//     created per bridge instance. storage + metadata close over pluginId.
//   - Hook context slot (currentFsTaskHost, currentTaskId): set by Plan C
//     BridgeHookEnter events. For Task 19, absent → throws clear error code.
//   - ffmpeg ops map: tracks running FfmpegOpHandle instances by opId so the
//     worker can poll progress, await result, or abort.

import { Worker } from 'node:worker_threads'
import type { SupportedLocale } from '@shared/constants/locales'
import type { PluginManifest } from '@shared/types/plugin'
import { z } from 'zod'
import type { FfmpegOpHandle, FfmpegProgress } from '../capabilities/ffmpeg'
import { HttpCapabilityHost } from '../capabilities/http'
import type { CapabilityHost } from '../capabilities/interface'
import { validateFinalizePatch, validateHttpPatch } from '../hooks/ctx-update'
import { classifyFfmpegOutput } from '../hooks/ffmpeg-path-classify'
import type { Phase } from '../hooks/phase-matrix'
import { phaseMatrix } from '../hooks/phase-matrix'
import type { RoleBand } from '../hooks/role-band'
import type { StagedEffectStore } from '../hooks/staged-effects'
import type { FfmpegStaging } from '../hooks/staging-dir'
import type {
  BridgeCallMessage,
  BridgeDeactivate,
  BridgeInitMessage,
  HookName,
  HostToWorker,
  WorkerToHost,
} from './bridge-protocol'

export interface CapabilityBridgeOptions {
  pluginId: string
  manifest: PluginManifest
  bundleSource: string
  capabilityHost: CapabilityHost
  workerScriptPath: string
  heapMB: number
  appVersion: string
  runtime: 'electron' | 'server'
  hostLanguage: SupportedLocale
  /**
   * Spec §I30 — runtime permission gate. `required ∪ (optional ∩ granted)`.
   * Methods whose permission isn't in this set throw
   * `plugin.capability.unavailable` with `reason: 'permission_denied'`.
   * When omitted, gating is disabled (back-compat for tests / pre-Phase-2
   * call sites). PluginHost passes the resolved set per activation; grant
   * changes deactivate the plugin so the next activation gets a fresh set.
   */
  effectivePermissions?: ReadonlySet<string>
}

/**
 * Capability → permission name(s). Capabilities not listed here are
 * auto-injected (log, app, i18n, crypto, lifecycle, commands, config, ctx)
 * and bypass the gate. For capabilities with both read/write split
 * (`fs.task`), the array is matched as "any of these"; the dispatch
 * method-level check is left to the capability host (spec §I30 is
 * capability-scope, not method-scope, in Phase 1A).
 */
const CAPABILITY_PERMISSIONS: Record<string, ReadonlyArray<string>> = {
  http: ['http'],
  notify: ['notify'],
  ffmpeg: ['ffmpeg'],
  'fs.task': ['fs.task.read', 'fs.task.write'],
  'fs.storage': ['fs.storage'],
  storage: ['storage'],
  metadata: ['metadata'],
}

export interface BridgeEvents {
  onRegister?(kind: 'hook' | 'command', key: string): void
  onFatal?(code: string, message: string): void
  onReady?(): void
}

/**
 * Discriminated union for `CapabilityBridge.setHookContext`.
 *
 * Plan B callers pass only `{ fsTaskHost, taskId }` — the matrix gate stays
 * idle. Plan C callers pass the full set; TS rejects half-filled args (e.g.,
 * `{ fsTaskHost, taskId, phase: 'beforeCreate' }` without staged/role/saveDir)
 * at compile time so the matrix gate cannot trip into the "staged store
 * missing" path silently.
 */
export type HookContextArgs =
  | {
      fsTaskHost: ReturnType<CapabilityHost['fsTaskFor']>
      taskId: string
    }
  | {
      fsTaskHost: ReturnType<CapabilityHost['fsTaskFor']>
      taskId: string
      phase: Phase
      staged: StagedEffectStore
      role: RoleBand
      saveDir: string
      pluginStorageRoot: string // required in Plan C — ffmpeg gate uses it for path-escape validation
      staging?: FfmpegStaging // optional — only beforeFinalize ffmpeg paths need it
    }

/**
 * Error carrying a stable `code` string, used by the dispatch catch block and
 * the worker bridge to marshal `{ code, message }` back to the plugin VM.
 *
 * Behaviorally equivalent to the previous `Object.assign(new Error(msg), {
 * code })` idiom: `.message` and own-enumerable `.code` are identical and
 * `.name` stays `'Error'` (the constructor deliberately does not override it),
 * so existing consumers that read `.code` / `.message` are unaffected.
 */
class PluginCodedError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Zod schemas for argument validation
// ---------------------------------------------------------------------------

const logArgsSchema = z.tuple([z.string()]).rest(z.unknown())

const cryptoRandomBytesSchema = z.tuple([z.number().int().min(1).max(4096)])

const cryptoHashSchema = z.tuple([
  // md5 is hash-only (legacy signing schemes, e.g. bilibili WBI); the guest
  // type (virtual-module.d.ts) already advertises it. Keep this enum in sync.
  z.enum(['md5', 'sha1', 'sha256', 'sha384', 'sha512']),
  z.union([z.string(), z.instanceof(Uint8Array)]),
])

const cryptoHmacSchema = z.tuple([
  z.enum(['sha1', 'sha256', 'sha384', 'sha512']),
  z.instanceof(Uint8Array),
  z.union([z.string(), z.instanceof(Uint8Array)]),
])

const cryptoAesSchema = z.tuple([
  z.object({
    mode: z.enum(['cbc', 'gcm']),
    op: z.enum(['encrypt', 'decrypt']),
    key: z.instanceof(Uint8Array),
    iv: z.instanceof(Uint8Array),
    data: z.instanceof(Uint8Array),
  }),
])

const storageGetSchema = z.tuple([z.string()])
const storageSetSchema = z.tuple([z.string(), z.unknown()])
const storageCasSchema = z.tuple([z.string(), z.number(), z.unknown()])
const storageDeleteSchema = z.tuple([z.string()])
const storageKeysSchema = z.tuple([]).or(z.tuple([z.string().optional()]))

const metadataGetSchema = z.tuple([z.string()])
const metadataSetSchema = z.tuple([z.string(), z.unknown()])
const metadataDeleteSchema = z.tuple([z.string()])

const httpRequestSchema = z.object({
  url: z.string(),
  method: z.string().optional(),
  // Spec §4 L1171: headers as Array<{name, value}>; preserves duplicates and
  // case. Object form is accepted for back-compat (a few internal call sites
  // historically passed Record; they are folded into the array form at
  // dispatch time).
  headers: z
    .union([
      z.array(z.object({ name: z.string(), value: z.string() })),
      z.record(z.string(), z.string()),
    ])
    .optional(),
  body: z
    .object({
      type: z.enum(['string', 'json', 'bytes']),
      data: z.unknown(),
    })
    .optional(),
  responseType: z.enum(['text', 'json', 'bytes']),
  timeoutMs: z.number().optional(),
  maxBodyBytes: z.number().optional(),
  redirect: z.enum(['follow', 'manual', 'error']).optional(),
  cookies: z.enum(['jar', 'none']).optional(),
  range: z
    .object({ start: z.number().int().nonnegative(), end: z.number().int() })
    .optional(),
  proxy: z.string().optional(),
})

const notifyShowSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  body: z.string(),
  icon: z.enum(['info', 'success', 'error']).optional(),
  urgency: z.enum(['low', 'normal', 'critical']).optional(),
})

const configGetSchema = z.tuple([z.string()])

const fsStorageReadSchema = z.tuple([
  z.string(),
  z.object({ encoding: z.enum(['utf8', 'binary']).optional() }).optional(),
])

const fsStorageWriteSchema = z.tuple([
  z.string(),
  z.union([z.string(), z.instanceof(Uint8Array)]),
  z
    .object({
      overwrite: z.boolean().optional(),
      encoding: z.enum(['utf8', 'binary']).optional(),
    })
    .optional(),
])

const fsStorageDeleteSchema = z.tuple([z.string()])
const fsStorageRenameSchema = z.tuple([z.string(), z.string()])
const fsStorageMkdirSchema = z.tuple([
  z.string(),
  z.object({ recursive: z.boolean().optional() }).optional(),
])

const ffmpegRunSchema = z.object({
  argv: z.array(z.string()),
  outputPath: z.string(),
  timeoutMs: z.number().optional(),
  expectedDurationMs: z.number().optional(),
})

const ffmpegTranscodeSchema = z.object({
  input: z.string(),
  output: z.string(),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
  timeoutMs: z.number().optional(),
  expectedDurationMs: z.number().optional(),
})

const ffmpegExtractAudioSchema = z.object({
  input: z.string(),
  output: z.string(),
  codec: z.enum(['mp3', 'aac', 'flac', 'wav']).optional(),
  timeoutMs: z.number().optional(),
  expectedDurationMs: z.number().optional(),
})

const ffmpegMergeStreamsSchema = z.object({
  videoInput: z.string(),
  audioInput: z.string(),
  output: z.string(),
  timeoutMs: z.number().optional(),
})

const ffmpegThumbnailSchema = z.object({
  input: z.string(),
  output: z.string(),
  timestampSec: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  timeoutMs: z.number().optional(),
})

const ffmpegProbeSchema = z.object({ path: z.string() })

const ffmpegOpIdSchema = z.tuple([z.string()])

const commandsExecuteSchema = z.tuple([z.string(), z.unknown()])

// ---------------------------------------------------------------------------
// FfmpegOpEntry — tracks a running ffmpeg operation
// ---------------------------------------------------------------------------

interface FfmpegOpEntry {
  handle: FfmpegOpHandle<{ outputPath: string }>
  lastProgress: FfmpegProgress | null
  lastEmitTs: number
  // Drive the progress iterable so lastProgress stays current.
  // The pump loop runs asynchronously and self-terminates when the iterator ends.
}

// ---------------------------------------------------------------------------
// CapabilityBridge
// ---------------------------------------------------------------------------

export class CapabilityBridge {
  private readonly worker: Worker
  private readonly log: ReturnType<CapabilityHost['createLog']>
  private disposed = false

  // Per-plugin lazy instances (constructed once on first use).
  private pluginHttpHost: HttpCapabilityHost | null = null
  private pluginFsStorage: ReturnType<CapabilityHost['fsStorageFor']> | null =
    null
  private pluginConfig: ReturnType<CapabilityHost['configFor']> | null = null

  // Hook context slot — populated by Plan C BridgeHookEnter handling.
  // Task 19: stays null; callers that need it get plugin.fs.task.not_available_outside_hook.
  private currentFsTaskHost: ReturnType<CapabilityHost['fsTaskFor']> | null =
    null
  private currentTaskId: string | null = null
  // Phase × Capability matrix fields (Task 8 / Plan C).
  private currentPhase: Phase | 'idle' = 'idle'
  private staged: StagedEffectStore | null = null
  private hookRole: RoleBand | null = null
  private hookSaveDir: string | null = null
  // Task 13: ffmpeg staging dir (set by Plan C for beforeFinalize only).
  private hookStaging: FfmpegStaging | null = null
  // Task 2: per-plugin storage root, used by ffmpeg gate for path-escape validation.
  private hookPluginStorageRoot: string | null = null

  /** Test-only probe — kept on the public surface because TS lacks a clean way
   *  to expose private state to vitest without a cast. Do not use from production code. */
  _debugPluginStorageRoot(): string | null {
    return this.hookPluginStorageRoot
  }

  // ffmpeg running op registry
  private readonly ffmpegOps = new Map<string, FfmpegOpEntry>()

  // Pending callPlugin() promises: correlation id → {resolve, reject}
  private readonly pendingCommandCalls = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  private nextCommandCallId = 1

  // Pending runDeactivate() resolve/reject — at most one in-flight at a time.
  private pendingDeactivate: {
    resolve: () => void
    reject: (e: Error) => void
  } | null = null

  // Pending callHook() resolve/reject — at most one in-flight at a time. Plan C
  // serializes hook calls per plugin, so a single slot is sufficient.
  private pendingHook: {
    resolve: () => void
    reject: (e: Error) => void
    detach: () => void
  } | null = null

  constructor(
    private readonly opts: CapabilityBridgeOptions,
    private readonly events: BridgeEvents = {}
  ) {
    this.log = opts.capabilityHost.createLog(opts.pluginId)
    this.worker = new Worker(opts.workerScriptPath, {
      resourceLimits: {
        maxOldGenerationSizeMb: opts.heapMB,
        stackSizeMb: 1,
      },
    })
    this.worker.on('message', (msg: WorkerToHost) => this.onMessage(msg))
    this.worker.on('error', (e) => {
      this.events.onFatal?.(
        'plugin.runtime.worker_crashed',
        (e as Error).message
      )
    })
    this.worker.on('exit', (code) => {
      if (!this.disposed && code !== 0) {
        this.events.onFatal?.(
          'plugin.runtime.worker_exited',
          `worker exited with code ${code}`
        )
      }
    })
    this.sendInit()
  }

  private sendInit(): void {
    const init: BridgeInitMessage = {
      type: 'init',
      pluginId: this.opts.pluginId,
      manifest: this.opts.manifest,
      bundleSource: prepareBundle(this.opts.bundleSource),
      app: this.opts.capabilityHost.appSnapshot(),
      i18n: this.opts.capabilityHost.i18nSnapshot(this.opts.pluginId),
      limits: { heapMB: this.opts.heapMB, stackKB: 256 },
    }
    this.worker.postMessage(init)
  }

  private async onMessage(msg: WorkerToHost): Promise<void> {
    if (msg.type === 'ready') {
      this.events.onReady?.()
      return
    }
    if (msg.type === 'register') {
      this.events.onRegister?.(msg.kind, msg.key)
      return
    }
    if (msg.type === 'fatal') {
      this.events.onFatal?.(msg.code, msg.message)
      return
    }
    if (msg.type === 'event' && msg.event === 'hookExit') {
      // Plan C: settle the pending callHook promise (if any) and clear the
      // hook context slot. The pending promise is created by callHook() —
      // Plan B callers that simply set hook context manually have no pending
      // promise, in which case we just clear the slot.
      this.clearHookContext()
      const pending = this.pendingHook
      this.pendingHook = null
      if (pending) {
        pending.detach()
        if (msg.ok) {
          pending.resolve()
        } else {
          const code = msg.errorCode ?? 'plugin.runtime.fault'
          const e: Error & { code?: string } = new Error(
            `plugin hook failed: ${code}`
          )
          e.code = code
          pending.reject(e)
        }
      }
      return
    }
    if (msg.type === 'event' && msg.event === 'executeCommandResult') {
      const pending = this.pendingCommandCalls.get(msg.id)
      if (pending) {
        this.pendingCommandCalls.delete(msg.id)
        if (msg.ok) {
          pending.resolve(msg.result)
        } else {
          const e: Error & { code?: string } = new Error(msg.errorMessage)
          e.code = msg.errorCode
          pending.reject(e)
        }
      }
      return
    }
    if (msg.type === 'event' && msg.event === 'deactivateComplete') {
      const pending = this.pendingDeactivate
      this.pendingDeactivate = null
      if (pending) {
        if (msg.ok) {
          pending.resolve()
        } else {
          const e: Error & { code?: string } = new Error(
            `plugin deactivate handler failed: ${msg.errorCode ?? 'unknown'}`
          )
          e.code = msg.errorCode
          pending.reject(e)
        }
      }
      return
    }
    if (msg.type === 'call') {
      await this.dispatchCall(msg)
      return
    }
  }

  // -------------------------------------------------------------------------
  // Main dispatch table
  // -------------------------------------------------------------------------

  async dispatchCall(msg: BridgeCallMessage): Promise<void> {
    // Spec §I30 — runtime permission gate. Rejects capability calls whose
    // permission isn't in `effectivePermissions`. Auto-injected capabilities
    // (log/app/i18n/crypto/lifecycle/commands/config/ctx) bypass.
    if (!this.permitted(msg.capability)) {
      this.sendError(
        msg.id,
        'plugin.capability.unavailable',
        `${msg.capability}.${msg.method} denied: optional permission not granted`
      )
      return
    }

    // Phase × Capability matrix gate (I28).
    // When a hook is active, look up the verdict and handle staged/disallowed
    // paths before the normal dispatch table. When idle, fall through as before.
    if (this.currentPhase !== 'idle') {
      const verdict = phaseMatrix(msg.capability, msg.method, this.currentPhase)
      if (verdict === 'disallowed') {
        this.sendError(
          msg.id,
          'plugin.capability.disallowed_in_phase',
          `${msg.capability}.${msg.method} not allowed in ${this.currentPhase}`
        )
        return
      }
      if (verdict === 'staged') {
        await this.handleStaged(msg)
        return
      }
    }
    try {
      let result: unknown
      switch (msg.capability) {
        case 'log':
          result = await this.dispatchLog(msg)
          break
        case 'app':
          result = await this.dispatchApp(msg)
          break
        case 'i18n':
          result = await this.dispatchI18n(msg)
          break
        case 'http':
          result = await this.dispatchHttp(msg)
          break
        case 'fs.task':
          result = await this.dispatchFsTask(msg)
          break
        case 'fs.storage':
          result = await this.dispatchFsStorage(msg)
          break
        case 'storage':
          result = await this.dispatchStorage(msg)
          break
        case 'metadata':
          result = await this.dispatchMetadata(msg)
          break
        case 'crypto':
          result = await this.dispatchCrypto(msg)
          break
        case 'config':
          result = await this.dispatchConfig(msg)
          break
        case 'lifecycle':
          result = await this.dispatchLifecycle(msg)
          break
        case 'commands':
          result = await this.dispatchCommands(msg)
          break
        case 'notify':
          result = await this.dispatchNotify(msg)
          break
        case 'ffmpeg':
          result = await this.dispatchFfmpeg(msg)
          break
        default:
          return this.sendError(
            msg.id,
            'plugin.capability.unknown',
            `unknown capability: ${msg.capability}`
          )
      }
      this.sendResponse(msg.id, result)
    } catch (e: unknown) {
      const code = (e as { code?: string }).code ?? 'plugin.runtime.fault'
      const message = (e as Error).message ?? String(e)
      this.sendError(msg.id, code, message)
    }
  }

  // -------------------------------------------------------------------------
  // Response helpers
  // -------------------------------------------------------------------------

  private sendResponse(id: number, result: unknown): void {
    const resp: HostToWorker = { type: 'response', id, ok: true, result }
    this.worker.postMessage(resp)
  }

  private sendError(id: number, code: string, message: string): void {
    const resp: HostToWorker = {
      type: 'response',
      id,
      ok: false,
      error: { code, message },
    }
    this.worker.postMessage(resp)
  }

  /**
   * Returns true if the capability's required permission(s) are in the
   * resolved effective set. Capabilities not in CAPABILITY_PERMISSIONS are
   * always permitted (auto-injected). When `effectivePermissions` is
   * undefined, all capabilities are permitted (back-compat for tests).
   */
  private permitted(capability: string): boolean {
    const required = CAPABILITY_PERMISSIONS[capability]
    if (!required) return true
    const eff = this.opts.effectivePermissions
    if (!eff) return true
    return required.some((p) => eff.has(p))
  }

  // -------------------------------------------------------------------------
  // log
  // -------------------------------------------------------------------------

  private dispatchLog(msg: BridgeCallMessage): void {
    const parsed = logArgsSchema.safeParse(msg.args)
    if (!parsed.success) {
      throw new PluginCodedError(
        'plugin.capability.bad_args',
        `log.${msg.method}: invalid args`
      )
    }
    const [text, ...rest] = parsed.data
    const fields = rest[0] as Record<string, unknown> | undefined
    const fn = (
      this.log as unknown as Record<string, (m: string, f?: object) => void>
    )[msg.method]
    if (typeof fn !== 'function') {
      throw new PluginCodedError(
        'plugin.capability.unavailable',
        `unknown log method: ${msg.method}`
      )
    }
    fn.call(this.log, String(text), fields)
  }

  // -------------------------------------------------------------------------
  // app — snapshot only; worker reads app.* from the init message.
  // Provide it here for completeness in case worker calls it post-init.
  // -------------------------------------------------------------------------

  private dispatchApp(_msg: BridgeCallMessage): unknown {
    return this.opts.capabilityHost.appSnapshot()
  }

  // -------------------------------------------------------------------------
  // i18n
  // -------------------------------------------------------------------------

  private dispatchI18n(msg: BridgeCallMessage): unknown {
    const snap = this.opts.capabilityHost.i18nSnapshot(this.opts.pluginId)
    if (msg.method === 'snapshot') {
      return snap
    }
    if (msg.method === 't') {
      const [key, params] = msg.args as [string, Record<string, unknown>?]
      const dict = {
        ...snap.fallbackDict,
        ...snap.currentDict,
      }
      let str = dict[key] ?? key
      if (params) {
        // Simple {{variable}} interpolation
        str = str.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) =>
          String(params[k] ?? `{{${k}}}`)
        )
      }
      return str
    }
    throw new PluginCodedError(
      'plugin.capability.unavailable',
      `unknown i18n method: ${msg.method}`
    )
  }

  // -------------------------------------------------------------------------
  // http
  // -------------------------------------------------------------------------

  private getPluginHttpHost(): HttpCapabilityHost {
    if (!this.pluginHttpHost) {
      const jar = this.opts.capabilityHost.cookieJarFor(this.opts.pluginId)
      this.pluginHttpHost = new HttpCapabilityHost({
        cookieJar: jar,
        // Confine outbound requests to the manifest's declared hosts — the
        // consent screen presents hostPermissions as the plugin's reach, so
        // the runtime must enforce it (no declaration ⇒ no hosts, rule I29).
        hostPermissions: this.opts.manifest.hostPermissions ?? [],
      })
    }
    return this.pluginHttpHost
  }

  private async dispatchHttp(msg: BridgeCallMessage): Promise<unknown> {
    const host = this.getPluginHttpHost()
    if (msg.method === 'request') {
      const [opts] = msg.args
      const parsed = httpRequestSchema.parse(opts)
      // Normalize legacy Record-shaped headers to the spec-aligned array form
      // expected by HttpCapabilityHost.request().
      const headers = parsed.headers
      const normalizedHeaders = Array.isArray(headers)
        ? headers
        : headers !== undefined
          ? Object.entries(headers).map(([name, value]) => ({ name, value }))
          : undefined
      const forHost = { ...parsed, headers: normalizedHeaders }
      // Cast body.data to the expected union — Zod z.unknown() is wider than
      // HttpRequestBody.data which is string | object | Uint8Array.
      return host.request(forHost as Parameters<typeof host.request>[0])
    }
    if (msg.method === 'get') {
      const [url, opts] = msg.args as [string, object?]
      return host.get(url, opts as Parameters<HttpCapabilityHost['get']>[1])
    }
    if (msg.method === 'post') {
      const [url, body, opts] = msg.args as [
        string,
        Parameters<HttpCapabilityHost['post']>[1],
        object?,
      ]
      return host.post(
        url,
        body,
        opts as Parameters<HttpCapabilityHost['post']>[2]
      )
    }
    throw new PluginCodedError(
      'plugin.capability.unavailable',
      `unknown http method: ${msg.method}`
    )
  }

  // -------------------------------------------------------------------------
  // fs.task — requires hook context (Plan C). Task 19 throws when no host.
  // -------------------------------------------------------------------------

  private async dispatchFsTask(msg: BridgeCallMessage): Promise<unknown> {
    if (!this.currentFsTaskHost) {
      throw new PluginCodedError(
        'plugin.fs.task.not_available_outside_hook',
        'fs.task is only available inside a hook invocation; no hook context is active'
      )
    }
    const host = this.currentFsTaskHost
    switch (msg.method) {
      case 'stat':
        return host.stat()
      case 'exists':
        return host.exists()
      case 'computeHash': {
        const [alg] = msg.args as [Parameters<typeof host.computeHash>[0]]
        return host.computeHash(alg)
      }
      case 'rename': {
        const [newName] = msg.args as [string]
        return host.rename(newName)
      }
      case 'openReader': {
        // openReader() returns a FsTaskReader with read()/close() methods.
        // The reader object cannot cross the worker boundary directly.
        // For Task 19 we return a sentinel so tests can verify the call reaches
        // the host. Task 20 worker proxy wraps this into a streaming API.
        // A real cross-boundary reader protocol is deferred to Task 20/Plan C.
        const [readerOpts] = msg.args as [{ offset?: number; length?: number }?]
        const reader = host.openReader(readerOpts ?? {})
        // Auto-close immediately in this stub; Task 20 tracks reader handles.
        reader.close()
        return { opened: true }
      }
      default:
        throw new PluginCodedError(
          'plugin.capability.unavailable',
          `unknown fs.task method: ${msg.method}`
        )
    }
  }

  // -------------------------------------------------------------------------
  // fs.storage — per-plugin, lazily constructed
  // -------------------------------------------------------------------------

  private getFsStorage(): ReturnType<CapabilityHost['fsStorageFor']> {
    if (!this.pluginFsStorage) {
      this.pluginFsStorage = this.opts.capabilityHost.fsStorageFor(
        this.opts.pluginId
      )
    }
    return this.pluginFsStorage
  }

  private async dispatchFsStorage(msg: BridgeCallMessage): Promise<unknown> {
    const host = this.getFsStorage()
    switch (msg.method) {
      case 'exists': {
        const [relPath] = msg.args as [string]
        return host.exists(relPath)
      }
      case 'stat': {
        const [relPath] = msg.args as [string]
        return host.stat(relPath)
      }
      case 'read': {
        const [relPath, opts] = fsStorageReadSchema.parse(msg.args)
        return host.read(relPath, opts)
      }
      case 'write': {
        const [relPath, data, opts] = fsStorageWriteSchema.parse(msg.args)
        return host.write(relPath, data, opts)
      }
      case 'delete': {
        const [relPath] = fsStorageDeleteSchema.parse(msg.args)
        return host.delete(relPath)
      }
      case 'rename': {
        const [src, dst] = fsStorageRenameSchema.parse(msg.args)
        return host.rename(src, dst)
      }
      case 'mkdir': {
        const [relPath, opts] = fsStorageMkdirSchema.parse(msg.args)
        return host.mkdir(relPath, opts)
      }
      default:
        throw new PluginCodedError(
          'plugin.capability.unavailable',
          `unknown fs.storage method: ${msg.method}`
        )
    }
  }

  // -------------------------------------------------------------------------
  // storage — shared SQLite KV; pluginId closed over
  // -------------------------------------------------------------------------

  private async dispatchStorage(msg: BridgeCallMessage): Promise<unknown> {
    const host = this.opts.capabilityHost.storage
    const pluginId = this.opts.pluginId
    switch (msg.method) {
      case 'get': {
        const [key] = storageGetSchema.parse(msg.args)
        return host.get(pluginId, key)
      }
      case 'set': {
        const [key, value] = storageSetSchema.parse(msg.args)
        return host.set(pluginId, key, value)
      }
      case 'compareAndSet': {
        const [key, expectedVersion, value] = storageCasSchema.parse(msg.args)
        return host.compareAndSet(pluginId, key, expectedVersion, value)
      }
      case 'delete': {
        const [key] = storageDeleteSchema.parse(msg.args)
        return host.delete(pluginId, key)
      }
      case 'keys': {
        const args = storageKeysSchema.safeParse(msg.args)
        const prefix = args.success
          ? (args.data[0] as string | undefined)
          : undefined
        return host.keys(pluginId, prefix)
      }
      default:
        throw new PluginCodedError(
          'plugin.capability.unavailable',
          `unknown storage method: ${msg.method}`
        )
    }
  }

  // -------------------------------------------------------------------------
  // metadata — requires hook context (taskId). Task 19 throws when none.
  // -------------------------------------------------------------------------

  private async dispatchMetadata(msg: BridgeCallMessage): Promise<unknown> {
    if (!this.currentTaskId) {
      throw new PluginCodedError(
        'plugin.metadata.not_available_outside_hook',
        'metadata is only available inside a hook invocation; no task context is active'
      )
    }
    const host = this.opts.capabilityHost.metadata
    const pluginId = this.opts.pluginId
    const taskId = this.currentTaskId
    switch (msg.method) {
      case 'get': {
        const [key] = metadataGetSchema.parse(msg.args)
        return host.get(taskId, pluginId, key)
      }
      case 'has': {
        const [key] = metadataGetSchema.parse(msg.args)
        return host.has(taskId, pluginId, key)
      }
      case 'getAll':
        return host.getAll(taskId, pluginId)
      case 'keys':
        return host.keys(taskId, pluginId)
      case 'set': {
        const [key, value] = metadataSetSchema.parse(msg.args)
        return host.set(taskId, pluginId, key, value)
      }
      case 'delete': {
        const [key] = metadataDeleteSchema.parse(msg.args)
        return host.delete(taskId, pluginId, key)
      }
      default:
        throw new PluginCodedError(
          'plugin.capability.unavailable',
          `unknown metadata method: ${msg.method}`
        )
    }
  }

  // -------------------------------------------------------------------------
  // crypto — stateless
  // -------------------------------------------------------------------------

  private async dispatchCrypto(msg: BridgeCallMessage): Promise<unknown> {
    const host = this.opts.capabilityHost.crypto
    switch (msg.method) {
      case 'randomBytes': {
        const [n] = cryptoRandomBytesSchema.parse(msg.args)
        return host.randomBytes(n)
      }
      case 'hash': {
        const [alg, input] = cryptoHashSchema.parse(msg.args)
        return host.hash(alg, input)
      }
      case 'hmac': {
        const [alg, key, input] = cryptoHmacSchema.parse(msg.args)
        return host.hmac(alg, key, input)
      }
      case 'aes': {
        const [params] = cryptoAesSchema.parse(msg.args)
        return host.aes(params)
      }
      default:
        throw new PluginCodedError(
          'plugin.capability.unavailable',
          `unknown crypto method: ${msg.method}`
        )
    }
  }

  // -------------------------------------------------------------------------
  // config — per-plugin, lazily constructed
  // -------------------------------------------------------------------------

  private getConfig(): ReturnType<CapabilityHost['configFor']> {
    if (!this.pluginConfig) {
      this.pluginConfig = this.opts.capabilityHost.configFor(this.opts.pluginId)
    }
    return this.pluginConfig
  }

  private async dispatchConfig(msg: BridgeCallMessage): Promise<unknown> {
    const host = this.getConfig()
    switch (msg.method) {
      case 'get': {
        const [key] = configGetSchema.parse(msg.args)
        return host.get(key)
      }
      case 'getRaw': {
        const [key] = configGetSchema.parse(msg.args)
        return host.getRaw(key)
      }
      case 'getAll':
        return host.getAll()
      default:
        throw new PluginCodedError(
          'plugin.capability.unavailable',
          `unknown config method: ${msg.method}`
        )
    }
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // Plan B: onDeactivate cannot round-trip a callback reference across the
  // worker boundary. Return {ok:true} immediately. Task 23 / Plan C will send
  // a BridgeDeactivate event that the worker handles by calling its stored fn.
  // -------------------------------------------------------------------------

  private dispatchLifecycle(msg: BridgeCallMessage): unknown {
    if (msg.method === 'onDeactivate') {
      // Stub: worker stores the fn locally; host will signal via event on dispose.
      // Task 23 wires the full deactivation protocol.
      return { registered: true }
    }
    throw new PluginCodedError(
      'plugin.capability.unavailable',
      `unknown lifecycle method: ${msg.method}`
    )
  }

  // -------------------------------------------------------------------------
  // commands
  // register: handled worker-side only (via 'register' event). Bridge just
  // records registrations. execute: cross-plugin dispatch via CommandsCapabilityHost.
  // -------------------------------------------------------------------------

  private async dispatchCommands(msg: BridgeCallMessage): Promise<unknown> {
    if (msg.method === 'execute') {
      const [commandId, args] = commandsExecuteSchema.parse(msg.args)
      return this.opts.capabilityHost.commands.execute(
        this.opts.pluginId,
        commandId,
        args
      )
    }
    // 'register' is handled worker-side (the worker sends a 'register' event).
    // The bridge does not need to do anything here.
    if (msg.method === 'register') {
      return { registered: true }
    }
    throw new PluginCodedError(
      'plugin.capability.unavailable',
      `unknown commands method: ${msg.method}`
    )
  }

  // -------------------------------------------------------------------------
  // notify
  // -------------------------------------------------------------------------

  private async dispatchNotify(msg: BridgeCallMessage): Promise<unknown> {
    if (msg.method === 'show') {
      const [opts] = msg.args
      const parsed = notifyShowSchema.parse(opts)
      return this.opts.capabilityHost.notify.show(this.opts.pluginId, parsed)
    }
    throw new PluginCodedError(
      'plugin.capability.unavailable',
      `unknown notify method: ${msg.method}`
    )
  }

  // -------------------------------------------------------------------------
  // ffmpeg — op handle pattern
  //
  // Launching methods (probe, run, transcode, extractAudio, mergeStreams,
  // generateThumbnail): kick off the operation, register the handle in
  // ffmpegOps, start a background pump loop that keeps lastProgress current,
  // return { opId } immediately.
  //
  // op.result.await(opId): awaits handle.result; resolves with result payload
  //   or rejects with FfmpegError.
  // op.progress.pull(opId): returns lastProgress (or keep-alive after 1s idle).
  // op.abort(opId): calls handle.abort().
  // -------------------------------------------------------------------------

  private registerFfmpegHandle(
    handle: FfmpegOpHandle<{ outputPath: string }>
  ): string {
    const opId = handle.id
    const entry: FfmpegOpEntry = {
      handle,
      lastProgress: null,
      lastEmitTs: 0,
    }
    this.ffmpegOps.set(opId, entry)

    // Pump loop: drive the progress AsyncIterable to keep lastProgress current.
    ;(async () => {
      try {
        for await (const p of handle.progress) {
          const e = this.ffmpegOps.get(opId)
          if (e) {
            e.lastProgress = p
            e.lastEmitTs = Date.now()
          }
        }
      } catch {
        // progress iterable closed on abort/error; handle.result carries the error
      } finally {
        // Do not remove from map here — caller may still await result.
      }
    })()

    return opId
  }

  /**
   * Phase × kind gate for ffmpeg output paths. Classifies the user-supplied
   * output against (hookSaveDir, hookPluginStorageRoot), then applies the
   * (phase, kind) table from spec §3.1 — saveDir is staged-only in
   * beforeFinalize, pluginStorage is immediate in all phases, anything else
   * is rejected. Throws AppError-shaped { code, message } pairs that the
   * dispatch catch block surfaces as plugin.ffmpeg.destination_phase_disallowed.
   *
   * Pre-Plan-C (orchestrator wires real pluginStorageRoot in PR-2), call sites
   * pass `pluginStorageRoot: ''`. Empty pluginStorageRoot short-circuits the
   * gate so legacy tests keep passing; once PR-2 lands, every Plan-C call site
   * has a real root and the gate becomes effective everywhere.
   */
  private async gateFfmpegOutput(userOutput: string): Promise<string> {
    if (this.currentPhase === 'idle') return userOutput
    if (!this.hookSaveDir || !this.hookPluginStorageRoot) {
      // Plan-B context or pre-PR-2 placeholder — gate inactive.
      return userOutput
    }
    const kind = classifyFfmpegOutput(
      userOutput,
      this.hookSaveDir,
      this.hookPluginStorageRoot
    )
    if (kind === 'pluginStorage') return userOutput
    if (kind === 'other') {
      throw new PluginCodedError(
        'plugin.ffmpeg.destination_phase_disallowed',
        `ffmpeg output ${userOutput} resolves outside saveDir and plugin storage`
      )
    }
    // kind === 'saveDir' — beforeFinalize + staging only.
    if (this.currentPhase !== 'beforeFinalize') {
      throw new PluginCodedError(
        'plugin.ffmpeg.destination_phase_disallowed',
        `ffmpeg cannot write to saveDir in ${this.currentPhase}; move this call into beforeFinalize or write to plugin storage`
      )
    }
    if (!this.hookStaging) {
      throw new PluginCodedError(
        'plugin.ffmpeg.destination_phase_disallowed',
        'ffmpeg saveDir write in beforeFinalize requires a FfmpegStaging in HookContextArgs'
      )
    }
    const staged = this.hookStaging.redirectOutput(userOutput)
    // ensureDir must precede assertQuota: assertQuota does a readdir of the staging dir.
    await this.hookStaging.ensureDir()
    await this.hookStaging.assertQuota()
    return staged
  }

  private async dispatchFfmpeg(msg: BridgeCallMessage): Promise<unknown> {
    const ffmpeg = this.opts.capabilityHost.ffmpeg

    // ── op lifecycle methods ───────────────────────────────────────────────
    if (msg.method === 'op.result.await') {
      const [opId] = ffmpegOpIdSchema.parse(msg.args)
      const entry = this.ffmpegOps.get(opId)
      if (!entry) {
        throw new PluginCodedError(
          'plugin.ffmpeg.op_not_found',
          `ffmpeg op not found: ${opId}`
        )
      }
      try {
        const result = await entry.handle.result
        this.ffmpegOps.delete(opId)
        return result
      } catch (e: unknown) {
        this.ffmpegOps.delete(opId)
        throw e
      }
    }

    if (msg.method === 'op.progress.pull') {
      const [opId] = ffmpegOpIdSchema.parse(msg.args)
      const entry = this.ffmpegOps.get(opId)
      if (!entry) {
        throw new PluginCodedError(
          'plugin.ffmpeg.op_not_found',
          `ffmpeg op not found: ${opId}`
        )
      }
      if (entry.lastProgress !== null) {
        return entry.lastProgress
      }
      // Keep-alive: wait up to 1s for a progress event to arrive.
      return new Promise<FfmpegProgress | null>((resolve) => {
        let poll: ReturnType<typeof setInterval>
        const deadline = setTimeout(() => {
          clearInterval(poll)
          resolve(null)
        }, 1_000)
        poll = setInterval(() => {
          const e = this.ffmpegOps.get(opId)
          if (e?.lastProgress !== null) {
            clearTimeout(deadline)
            clearInterval(poll)
            resolve(e?.lastProgress ?? null)
          }
        }, 50)
      })
    }

    if (msg.method === 'op.abort') {
      const [opId] = ffmpegOpIdSchema.parse(msg.args)
      const entry = this.ffmpegOps.get(opId)
      if (!entry) {
        // Already completed or never started — not an error.
        return { aborted: false }
      }
      entry.handle.abort()
      return { aborted: true }
    }

    // ── launch methods ─────────────────────────────────────────────────────
    if (msg.method === 'probe') {
      const [opts] = msg.args
      const parsed = ffmpegProbeSchema.parse(opts)
      // probe returns a Promise<MediaInfo> directly, not an op handle.
      return ffmpeg.probe(parsed)
    }

    if (msg.method === 'run') {
      const [opts] = msg.args
      const parsed = ffmpegRunSchema.parse(opts)
      parsed.outputPath = await this.gateFfmpegOutput(parsed.outputPath)
      const handle = ffmpeg.run(parsed)
      const opId = this.registerFfmpegHandle(handle)
      return { opId }
    }

    if (msg.method === 'transcode') {
      const [opts] = msg.args
      const parsed = ffmpegTranscodeSchema.parse(opts)
      parsed.output = await this.gateFfmpegOutput(parsed.output)
      const handle = ffmpeg.transcode(parsed)
      const opId = this.registerFfmpegHandle(handle)
      return { opId }
    }

    if (msg.method === 'extractAudio') {
      const [opts] = msg.args
      const parsed = ffmpegExtractAudioSchema.parse(opts)
      parsed.output = await this.gateFfmpegOutput(parsed.output)
      const handle = ffmpeg.extractAudio(parsed)
      const opId = this.registerFfmpegHandle(handle)
      return { opId }
    }

    if (msg.method === 'mergeStreams') {
      const [opts] = msg.args
      const parsed = ffmpegMergeStreamsSchema.parse(opts)
      parsed.output = await this.gateFfmpegOutput(parsed.output)
      const handle = ffmpeg.mergeStreams(parsed)
      const opId = this.registerFfmpegHandle(handle)
      return { opId }
    }

    if (msg.method === 'generateThumbnail') {
      const [opts] = msg.args
      const parsed = ffmpegThumbnailSchema.parse(opts)
      parsed.output = await this.gateFfmpegOutput(parsed.output)
      const handle = ffmpeg.generateThumbnail(parsed)
      const opId = this.registerFfmpegHandle(handle)
      return { opId }
    }

    throw new PluginCodedError(
      'plugin.capability.unavailable',
      `unknown ffmpeg method: ${msg.method}`
    )
  }

  // -------------------------------------------------------------------------
  // Plan C injection points
  // -------------------------------------------------------------------------

  /**
   * Called by Plan C when a hook invocation begins. Sets the fs.task,
   * metadata, phase, staged-effect store, role and saveDir context for the
   * duration of the hook.
   *
   * Accepts either:
   * - `{ fsTaskHost, taskId }` — Plan B context only (matrix gate inactive)
   * - `{ fsTaskHost, taskId, phase, staged, role, saveDir }` — full Plan C
   *   context (matrix gate active). The four Plan C fields are atomic: TS
   *   rejects partial Plan C args at compile time.
   */
  setHookContext(args: HookContextArgs): void {
    this.currentFsTaskHost = args.fsTaskHost
    this.currentTaskId = args.taskId
    if ('phase' in args) {
      this.currentPhase = args.phase
      this.staged = args.staged
      this.hookRole = args.role
      this.hookSaveDir = args.saveDir
      this.hookPluginStorageRoot = args.pluginStorageRoot
      this.hookStaging = args.staging ?? null
    } else {
      this.currentPhase = 'idle'
      this.staged = null
      this.hookRole = null
      this.hookSaveDir = null
      this.hookPluginStorageRoot = null
      this.hookStaging = null
    }
  }

  /**
   * Called by PluginHost when the host locale changes. Posts a `localeChange`
   * event to the worker so the plugin runtime can update its translation dict.
   */
  postLocaleChange(
    lang: string,
    dir: 'ltr' | 'rtl',
    dict: Record<string, string>
  ): void {
    if (this.disposed) return
    this.worker.postMessage({
      type: 'event',
      event: 'localeChange',
      lang,
      dir,
      dict,
    })
  }

  /**
   * Called by abort.ts when the host-owned AbortController fires. Posts an
   * 'abort' event to the worker so the plugin runtime can cancel in-flight ops.
   *
   * TODO(T16): also cancel any tracked ffmpeg/http handles held by this bridge.
   */
  notifyAbort(): void {
    if (this.disposed) return
    this.worker.postMessage({ type: 'event', event: 'abort' })
  }

  /**
   * Called by Plan C (or by the hookExit event handler) to clear hook context.
   */
  clearHookContext(): void {
    this.currentFsTaskHost = null
    this.currentTaskId = null
    this.currentPhase = 'idle'
    this.staged = null
    this.hookRole = null
    this.hookSaveDir = null
    this.hookPluginStorageRoot = null
    this.hookStaging = null
  }

  /**
   * Routes a dispatch call to the staged-effect store when the phase matrix
   * returns `'staged'`. Validates the patch/op and appends to the store.
   * Sends a response (ok or error) to the worker.
   */
  private async handleStaged(msg: BridgeCallMessage): Promise<void> {
    if (!this.staged || !this.hookRole || this.hookSaveDir === null) {
      this.sendError(msg.id, 'plugin.runtime.fault', 'staged store missing')
      return
    }
    const perms = new Set(this.opts.manifest.permissions ?? [])
    const opts = {
      permissions: perms as ReadonlySet<string>,
      role: this.hookRole,
      hook: (this.currentPhase === 'beforeCreate'
        ? 'beforeCreate'
        : 'beforeFinalize') as 'beforeCreate' | 'beforeFinalize',
      saveDir: this.hookSaveDir,
    }
    if (msg.capability === 'ctx' && msg.method === 'update') {
      try {
        const patch = msg.args[0]
        const validated =
          this.currentPhase === 'beforeCreate'
            ? validateHttpPatch(patch, opts)
            : validateFinalizePatch(patch, opts)
        if (this.currentPhase === 'beforeCreate') {
          this.staged.appendHttp(
            this.opts.pluginId,
            this.hookRole,
            validated as Parameters<typeof this.staged.appendHttp>[2]
          )
        } else {
          this.staged.setFinalizePath(
            (validated as { filePath: string }).filePath
          )
        }
        this.sendResponse(msg.id, undefined)
      } catch (e: unknown) {
        const code = (e as { code?: string }).code ?? 'plugin.runtime.fault'
        const message = (e as Error).message ?? String(e)
        this.sendError(msg.id, code, message)
      }
      return
    }
    if (msg.capability === 'metadata') {
      if (msg.method === 'set') {
        this.staged.appendMeta({
          pluginId: this.opts.pluginId,
          op: 'set',
          key: msg.args[0] as string,
          value: msg.args[1],
        })
        this.sendResponse(msg.id, undefined)
        return
      }
      if (msg.method === 'delete') {
        this.staged.appendMeta({
          pluginId: this.opts.pluginId,
          op: 'delete',
          key: msg.args[0] as string,
        })
        this.sendResponse(msg.id, undefined)
        return
      }
    }
    // Unrecognized staged dispatch — should not happen if matrix is correct.
    this.sendError(
      msg.id,
      'plugin.runtime.fault',
      `staged dispatch not implemented for ${msg.capability}.${msg.method}`
    )
  }

  /**
   * Invoke a registered command inside the plugin VM and await its result.
   * The command must have been registered during activation via commands.register().
   * Used by test-helpers.ts and future Plan C invocations.
   *
   * @param commandId   Fully-qualified command id (e.g. 'test.allcaps.echoAll').
   * @param args        Arguments passed to the command handler.
   * @param timeoutMs   Max wait time (default: 10s).
   */
  callPlugin(
    commandId: string,
    args: unknown,
    timeoutMs = 10_000
  ): Promise<unknown> {
    const id = this.nextCommandCallId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingCommandCalls.has(id)) {
          this.pendingCommandCalls.delete(id)
          reject(
            new Error(
              `callPlugin('${commandId}') timed out after ${timeoutMs}ms`
            )
          )
        }
      }, timeoutMs)

      this.pendingCommandCalls.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })

      const msg: HostToWorker = {
        type: 'event',
        event: 'executeCommand',
        id,
        commandId,
        args,
      }
      this.worker.postMessage(msg)
    })
  }

  /**
   * Signal the worker to run its registered `onDeactivate` handlers, then
   * await `BridgeDeactivateComplete` with a 2-second budget. Throws if the
   * worker reports an error or if the budget is exceeded.
   *
   * Must be called BEFORE `dispose()` so the worker thread is still alive.
   */
  runDeactivate(budgetMs = 2_000): Promise<void> {
    if (this.disposed) return Promise.resolve()

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingDeactivate) {
          this.pendingDeactivate = null
          const e: Error & { code?: string } = new Error(
            `plugin deactivate timed out after ${budgetMs}ms`
          )
          e.code = 'plugin.lifecycle.deactivate_timeout'
          reject(e)
        }
      }, budgetMs)

      this.pendingDeactivate = {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      }

      const msg: BridgeDeactivate = { type: 'event', event: 'deactivate' }
      this.worker.postMessage(msg)
    })
  }

  /**
   * Plan C — invoke a registered hook in the worker and await its completion.
   *
   * Posts a `hookEnter` event with the supplied taskId; the worker dispatches
   * to its registered handler (stored via `hooks.<name>(fn)` during activation)
   * and replies with `hookExit { ok, errorCode? }` when the handler resolves
   * or throws.
   *
   * The caller MUST call `setHookContext(...)` before this method so capability
   * dispatch (fs.task, metadata, ctx.update) routes correctly. The bridge
   * clears the context slot inside the `hookExit` handler.
   *
   * @param hook        Hook name as registered by the plugin.
   * @param taskId      Stable task id to send in `hookEnter`.
   * @param signal      AbortSignal from the host-owned HookAbortBudget; if it
   *                    fires (timeout or external abort), this rejects with
   *                    `plugin.hook.aborted`.
   * @param timeoutMs   Defensive timeout in case the worker never replies
   *                    (e.g. crash). Generally the AbortBudget's deadline is
   *                    shorter; this is the upper bound.
   */
  callHook(
    hook: HookName,
    taskId: string,
    signal: AbortSignal,
    timeoutMs: number,
    ctxPayload?: Record<string, unknown>,
    metadataSnapshot?: Record<string, unknown>
  ): Promise<void> {
    if (this.disposed) {
      return Promise.reject(
        new PluginCodedError(
          'plugin.runtime.bridge_disposed',
          'bridge disposed'
        )
      )
    }
    if (this.pendingHook) {
      return Promise.reject(
        new PluginCodedError(
          'plugin.hook.concurrent',
          `concurrent hook invocation rejected (one already in flight)`
        )
      )
    }

    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        if (this.pendingHook) {
          this.pendingHook.detach()
          this.pendingHook = null
          const e: Error & { code?: string } = new Error('plugin hook aborted')
          e.code = 'plugin.hook.aborted'
          reject(e)
        }
      }
      const timer = setTimeout(() => {
        if (this.pendingHook) {
          this.pendingHook.detach()
          this.pendingHook = null
          const e: Error & { code?: string } = new Error(
            `plugin hook timed out after ${timeoutMs}ms`
          )
          e.code = 'plugin.hook.timeout'
          reject(e)
        }
      }, timeoutMs)

      if (signal.aborted) {
        clearTimeout(timer)
        const e: Error & { code?: string } = new Error('plugin hook aborted')
        e.code = 'plugin.hook.aborted'
        reject(e)
        return
      }

      signal.addEventListener('abort', onAbort, { once: true })

      this.pendingHook = {
        resolve,
        reject,
        detach: () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
        },
      }

      this.worker.postMessage({
        type: 'event',
        event: 'hookEnter',
        hook,
        taskId,
        ctxPayload,
        metadataSnapshot,
      })
    })
  }

  /**
   * Plan C — public accessor for the underlying Worker. Required by
   * `newHookAbort(bridge, worker, timeoutMs)` so the abort budget can
   * `worker.terminate()` as a backstop for hung workers.
   */
  getWorker(): Worker {
    return this.worker
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    // Abort any running ffmpeg ops
    for (const entry of this.ffmpegOps.values()) {
      entry.handle.abort()
    }
    this.ffmpegOps.clear()
    this.worker.postMessage({ type: 'event', event: 'shutdown' })
    await this.worker.terminate()
  }
}

export function prepareBundle(source: string): string {
  // Replace `import { … } from 'motrix:plugin-api'` with a binding to
  // globalThis.__motrix_plugin_api__. QuickJS supports ES modules but
  // does not run a bundler resolver — we pre-transform at host-side.
  //
  // ES module import syntax uses `as` for renames:
  //     import { foo as bar } from 'motrix:plugin-api'
  // Object destructuring uses `:` for the same thing:
  //     const { foo: bar } = ...
  // Bundlers like esbuild emit `as`-renamed imports when minifying
  // identifier names; we MUST convert each `name as alias` to
  // `name: alias` here or the resulting `const { name as alias } = ...`
  // is a SyntaxError at QuickJS module load.
  const renameRe = /^([\w$]+)\s+as\s+([\w$]+)$/
  return source.replace(
    /import\s*\{([^}]+)\}\s*from\s*['"]motrix:plugin-api['"]\s*;?/g,
    (_, members) => {
      const names = members
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean)
        .map((member: string) => {
          const m = member.match(renameRe)
          return m ? `${m[1]}: ${m[2]}` : member
        })
      return `const { ${names.join(', ')} } = globalThis.__motrix_plugin_api__;`
    }
  )
}
