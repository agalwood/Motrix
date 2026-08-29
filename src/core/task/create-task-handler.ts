import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { stripHopByHopHeaders } from '@core/bridge-receiver/header-replay'
import { ensureMediaExtension } from '@core/bridge-receiver/pipelines/media-final-name'
import {
  type AdaptedMux,
  sanitizeFilename,
} from '@core/bridge-receiver/submit-download-adapter'
import type {
  AddTorrentParams,
  CreateDownloadParams,
  DirectResourceMetadataProfile,
  EngineAdapter,
} from '@core/engine/engine-adapter'
import { DIRECT_RESOURCE_METADATA_PROFILE } from '@core/engine/engine-adapter'
import { newEngineTaskId, newTaskId } from '@core/lib/ids'
import { getLogger } from '@core/logger'
import type { HookAuditLog } from '@core/plugin/hooks/audit-log'
import type { HookOrchestrator } from '@core/plugin/hooks/hook-orchestrator'
import type {
  AppliedDownloadProxyPolicyReader,
  AppliedDownloadProxySnapshot,
} from '@core/proxy/applied-download-proxy-policy'
import {
  extractAria2ProxyCredentials,
  normalizeAria2TaskProxyUrl,
  normalizeProxyUrl,
} from '@core/proxy/aria2-proxy-routing'
import type { SettingsManager } from '@core/settings/settings-manager'
import { INCOMPLETE_SUFFIX } from '@shared/constants/incomplete'
import { AppError, ErrorCode } from '@shared/errors'
import type {
  TaskCreateRequest,
  TaskCreateSuccessResult,
} from '@shared/schemas/add-task'
import { taskCreateRequestSchema } from '@shared/schemas/add-task'
import type { BeforeCreateHttpContextDTO } from '@shared/types/plugin-hooks'
import type {
  DownloadTask,
  SourceMeta,
  TaskInstance,
  TaskSource,
} from '@shared/types/task'
import {
  makeDefaultBtExtension,
  makeDownloadTask,
  TaskInstancePhase,
  TaskKind,
  TaskStatus,
  TaskType,
  TransitionPhase,
} from '@shared/types/task'
import { isTorrentLikeType } from '@shared/types/task-actions'
import type { TaskActivityRecorder } from '@shared/types/task-activity'
import type Database from 'better-sqlite3'
import {
  acquireBtInfoHashAdmission,
  existingFilesConflict,
  extractMagnetInfoHash,
  inspectBtDuplicate,
  reservedBtFinalNames,
  TorrentDuplicateConflictError,
} from './bt-duplicate-policy'
import {
  type BtStoragePlan,
  btStoragePayload,
  createBtStoragePlan,
  type ParsedBtFileLayout,
  parseBtFileLayout,
  shouldPrioritizeBtPreviewPieces,
  UnsafeTorrentPathError,
} from './bt-storage-layout'
import {
  buildDirectReplayRecipe,
  type DirectReplayRecipe,
} from './direct-replay-recipe'
import {
  canMirrorAria2MetadataHeaders,
  canRepresentDirectResourceHeaders,
  type DirectResourceMetadata,
  type DirectResourceRequestOptions,
  type DirectResourceValidatorService,
  sanitizeRemoteFilename,
} from './direct-resource-validator'
import type { FinalNamePicker } from './final-name-picker'
import { toTempPath } from './paths'
import type { TaskManager } from './task-manager'
import type { TorrentMetaStore } from './torrent-meta-store'

const log = getLogger('create-task')

type CreateDirectResourceValidator = Pick<
  DirectResourceValidatorService,
  'capture'
> &
  Partial<Pick<DirectResourceValidatorService, 'probe'>>

export interface CreateTaskDeps {
  adapter: EngineAdapter
  settingsManager: SettingsManager
  finalNamePicker: FinalNamePicker
  torrentMetaStore: TorrentMetaStore
  taskManager: TaskManager
  activityRecorder: TaskActivityRecorder
  eventBus: { emit(event: string, payload: unknown): void }
  /** Optional best-effort capture of a non-secret HTTP resource validator. */
  directResourceValidator?: CreateDirectResourceValidator
  /**
   * Holds the engine's applied proxy generation stable from metadata discovery
   * through the matching aria2 addUri dispatch.
   */
  directResourceProxyPolicy: AppliedDownloadProxyPolicyReader
  /**
   * Coalesced TaskUpdated publication (TaskUpdatePublisher.publish). Both
   * create-side broadcasts are non-terminal (announce a new owned task /
   * republish after a rolled-back create), so they ride the trailing window.
   */
  publishTaskUpdate: () => void
  // Optional plugin-hook plumbing (Plan C / T15). All three must be present
  // for the chain to fire; absence is a clean no-op for backward compat.
  orchestrator?: HookOrchestrator
  auditLog?: HookAuditLog
  db?: Database.Database
  /** Optional engine-readiness gate. Awaited immediately before each engine
   *  adapter call so a cold-start request waits for aria2 instead of hitting
   *  a not-yet-connected RPC socket. Absent ⇒ no gate (back-compat / tests). */
  waitForEngineReady?: () => Promise<void>
  /**
   * Synchronous readiness check used while an applied-proxy read lease is
   * held. It must not wait for a restart: a restarted engine belongs to a new
   * applied-proxy generation and the current admission must fail closed.
   */
  assertEngineReady?: () => void
  /**
   * Host-owned save-directory preflight. Server injects containment and
   * writability enforcement; Electron may omit it because its native picker
   * and shell own that policy.
   */
  prepareSaveDir?: (requested: string) => Promise<string>
  /** Rejecting parent-row durability barrier, invoked before publication. */
  persistTask?: (task: DownloadTask) => Promise<void>
  /**
   * Inspector Activity parent/Added barrier. The runtime invokes
   * `persistParent`, ensures the activity parent, and records Added before
   * returning.
   */
  parentTaskCreated?: (
    task: DownloadTask,
    persistParent: () => void | Promise<void>
  ) => Promise<void>
  /**
   * Compensating delete for a parent row whose durable create intent must be
   * rolled back. Production implementations must include the Inspector
   * Activity parent/timeline in the same serialized deletion.
   */
  rollbackTaskCreation?: (taskId: string) => Promise<void>
  /** Deterministic seam for tests; defaults to a random aria2-compatible GID. */
  createEngineTaskId?: () => string
  /** Serialize publication/removal races for the newly allocated public ID. */
  runTaskMutation?: <T>(
    taskIds: readonly string[],
    operation: () => Promise<T>
  ) => Promise<T>
  /**
   * Optional YouTube/bilibili pre-resolver. When present and the HTTP URL
   * resolves to a mux pair (video + audio), the download is routed to the
   * MuxPipeline instead of the normal HTTP engine path. Both deps must be
   * present for the seam to fire; absence of either → unchanged HTTP path.
   * Errors are owned by the factory (returns null → HTTP fallback).
   * The optional cookieHeader arg is for bilibili HD (desktop Add-Task path
   * passes no cookies — only the extension submit path forwards them).
   */
  resolveToMux?: (
    url: string,
    cookieHeader?: string
  ) => Promise<{
    videoUrl: string
    audioUrl: string
    container: 'mp4' | 'mkv'
    headers?: Record<string, string>
    title?: string
  } | null>
  /** Dispatch an AdaptedMux to the shared MuxPipeline. Must be paired with
   *  resolveToMux — both present or both absent. */
  dispatchMux?: (adapted: AdaptedMux) => Promise<{ taskId: string }>
  /** Re-adds a terminal BT task against its final layout with integrity
   * checking. Shell command handlers inject the existing reAddTask action. */
  reuseExistingBt?: (taskId: string) => Promise<void>
}

export interface CreateTaskOptions {
  source?: TaskSource // default 'user'
  sourceMeta?: SourceMeta // default null
  /** Engine option dictionary merged into the engine call: header
   *  (repeated), load-cookies, referer. createTaskHandler forwards these
   *  via CreateDownloadParams.extraEngineOptions; the adapter honors the
   *  keys it understands. */
  extraEngineOptions?: Record<string, string | string[]>
}

/**
 * Create a new download task. Side effects, in order:
 *   1. Resolve `finalName` via FinalNamePicker (collision-safe).
 *   2. Persist torrent bytes (BT torrent-base64 only) via TorrentMetaStore.
 *   3. Build engine-agnostic create params with path overrides so on-disk
 *      artifacts land in the task's in-flight location.
 *   4. Call the EngineAdapter to obtain the engine gid.
 *   5. Register the fully-populated DownloadTask with TaskManager so
 *      subsequent polling updates merge onto an already-present record
 *      (preserving diskPath / finalPath / finalName / transitionPhase /
 *      torrentMetaPath).
 *
 * The legacy IPC contract returned only `{ gid }`; the result now also
 * carries the freshly-minted `taskId` (== DownloadTask.id) so callers
 * that need the stable public identifier (notably the MDXP bridge, where
 * gid can rotate across instance swaps) don't have to reach into
 * TaskManager to look it up. Renderer-facing IPC paths still narrow to
 * `{ gid }` structurally — the extra field is harmless excess.
 */
export async function handleCreateTask(
  rawRequest: unknown,
  deps: CreateTaskDeps,
  opts: CreateTaskOptions = {}
): Promise<TaskCreateSuccessResult> {
  const parsed = taskCreateRequestSchema.safeParse(rawRequest)
  if (parsed.success && parsed.data.type === 'http') {
    const policy = deps.directResourceProxyPolicy
    // Cold-start waiting happens before taking the proxy read lease. Once the
    // lease is held, a later disconnect must fail fast instead of waiting on
    // a restart that belongs to a newer applied-route generation.
    if (deps.waitForEngineReady) {
      await deps.waitForEngineReady()
    }
    // Keep a runtime guard for untyped composition code: missing policy
    // injection must disable metadata I/O instead of consulting newer,
    // potentially unapplied SettingsManager values.
    return policy
      ? policy.runWithSnapshot((snapshot, lease) =>
          handleCreateTaskUnderAdmission(
            rawRequest,
            deps,
            opts,
            snapshot,
            lease.assertCurrent
          )
        )
      : handleCreateTaskUnderAdmission(rawRequest, deps, opts, null)
  }
  if (!parsed.success || parsed.data.type !== 'bt') {
    return handleCreateTaskUnderAdmission(rawRequest, deps, opts)
  }

  const req = parsed.data
  let infoHash =
    req.payload.kind === 'magnet'
      ? extractMagnetInfoHash(req.payload.uri)
      : null
  if (!infoHash && req.payload.kind === 'torrent-base64') {
    try {
      const bytes = req.torrentBytes ?? decodeBase64ToBytes(req.payload.base64)
      infoHash = (await parseBtFileLayout(bytes)).infoHash
    } catch {
      // The canonical create path below owns parse-error handling and logging.
    }
  }
  if (!infoHash) return handleCreateTaskUnderAdmission(rawRequest, deps, opts)

  const release = await acquireBtInfoHashAdmission(infoHash)
  try {
    return await handleCreateTaskUnderAdmission(rawRequest, deps, opts)
  } finally {
    release()
  }
}

async function handleCreateTaskUnderAdmission(
  rawRequest: unknown,
  deps: CreateTaskDeps,
  opts: CreateTaskOptions = {},
  appliedProxySnapshot?: AppliedDownloadProxySnapshot,
  assertAppliedProxyCurrent?: () => void
): Promise<TaskCreateSuccessResult> {
  const parsed = taskCreateRequestSchema.safeParse(rawRequest)
  if (!parsed.success) {
    throw new AppError(
      ErrorCode.IpcInvalidPayload,
      `Invalid task create request: ${parsed.error.message}`
    )
  }

  const req = parsed.data
  const appSettings = deps.settingsManager.getApp()
  const engineSettings = deps.settingsManager.getEngine()

  const requestedSaveDir = req.saveDir || appSettings.defaultSaveDir
  const effectiveSaveDir = deps.prepareSaveDir
    ? await deps.prepareSaveDir(requestedSaveDir)
    : requestedSaveDir
  const taskId = newTaskId()

  log.info(
    {
      type: req.type,
      payloadKind: req.type === 'bt' ? req.payload.kind : 'http',
      saveDir: effectiveSaveDir,
      selectedFiles: req.type === 'bt' ? req.selectedFiles.length : undefined,
    },
    'createTask received'
  )

  // Decode torrent bytes once — needed for both name extraction (info.name)
  // and TorrentMetaStore persistence. Bencode parsing lets us honor the
  // torrent's self-declared name instead of falling back to the literal
  // 'torrent' when neither displayName nor magnet dn= is provided.
  let torrentBytes: Uint8Array | null = null
  let torrentInfoName: string | null = null
  let parsedBtLayout: ParsedBtFileLayout | null = null
  let isPrivateFromTorrent = false
  if (req.type === 'bt' && req.payload.kind === 'torrent-base64') {
    torrentBytes = req.torrentBytes ?? decodeBase64ToBytes(req.payload.base64)
    try {
      parsedBtLayout = await parseBtFileLayout(torrentBytes)
      torrentInfoName = parsedBtLayout.torrentRootName
      isPrivateFromTorrent = parsedBtLayout.isPrivate
    } catch (err) {
      if (err instanceof UnsafeTorrentPathError) {
        throw new AppError(
          ErrorCode.TorrentParseFailed,
          'Torrent contains an unsafe file path',
          err
        )
      }
      log.warn(
        { err },
        'failed to parse torrent for indexed staging; falling back to legacy layout'
      )
    }
  }

  const btInfoHash =
    req.type !== 'bt'
      ? null
      : (parsedBtLayout?.infoHash ??
        (req.payload.kind === 'magnet'
          ? extractMagnetInfoHash(req.payload.uri)
          : null))

  if (req.type === 'bt' && btInfoHash) {
    const admission = inspectBtDuplicate(deps.taskManager.getAll(), {
      infoHash: btInfoHash,
      saveDir: effectiveSaveDir,
      selectedFiles: req.selectedFiles,
      duplicatePolicy: req.duplicatePolicy,
      excludeTaskId: req.existingTaskId,
    })
    if (admission.action === 'conflict') {
      throw new TorrentDuplicateConflictError(admission.conflict)
    }
    if (admission.action === 'reuse') {
      const didRecheck = admission.recheck && Boolean(deps.reuseExistingBt)
      if (didRecheck) {
        await deps.reuseExistingBt?.(admission.task.id)
      }
      const owner =
        deps.taskManager.getById(admission.task.id) ?? admission.task
      return {
        outcome: didRecheck ? 'rechecked' : 'reused',
        gid: owner.engineTaskId,
        taskId: owner.id,
      }
    }
  }

  // 1. Decide final on-disk name (handles collisions).
  const desiredName = deriveDesiredName(req, torrentInfoName)
  if (
    req.type === 'bt' &&
    btInfoHash &&
    req.duplicatePolicy === 'reuse' &&
    deps.finalNamePicker.isTaken &&
    (await deps.finalNamePicker.isTaken(effectiveSaveDir, desiredName))
  ) {
    throw existingFilesConflict(btInfoHash, effectiveSaveDir)
  }
  const reservedNames =
    req.type === 'bt'
      ? reservedBtFinalNames(
          deps.taskManager.getAll(),
          effectiveSaveDir,
          req.existingTaskId
        )
      : undefined
  let finalName =
    req.type === 'bt'
      ? await deps.finalNamePicker.pick(
          effectiveSaveDir,
          desiredName,
          reservedNames
        )
      : await deps.finalNamePicker.pick(effectiveSaveDir, desiredName)

  const taskType = deriveTaskType(req)
  let finalPath = path.join(effectiveSaveDir, finalName)
  const btStoragePlan: BtStoragePlan | null = parsedBtLayout
    ? createBtStoragePlan(taskId, effectiveSaveDir, parsedBtLayout)
    : null
  let diskPath = btStoragePlan?.layout.workspacePath ?? toTempPath(finalPath)
  // Anchor "now" early so the hook DTO's requestedAt and the persisted
  // task row share a clock — they are written in the same SQLite
  // transaction when plugin metadata is staged.
  const now = Date.now()

  // 2. Persist torrent bytes for the re-seed dance (BT with raw .torrent).
  let torrentMetaPath: string | null = null
  if (torrentBytes) {
    try {
      torrentMetaPath = await deps.torrentMetaStore.persist(
        taskId,
        torrentBytes
      )
    } catch (cause) {
      throw new AppError(
        ErrorCode.TaskCreateTorrentMetaFailed,
        'Failed to persist torrent metadata',
        cause
      )
    }
  }

  // 2.5. Pre-create the on-disk slot before handing off to aria2.
  // `diskPath` means different things by task family:
  //   - Parsed .torrent: `diskPath` is a short task workspace and index-out
  //     maps payload files below `<diskPath>/p`.
  //   - Unresolved magnet / legacy BT: `diskPath` is the traditional
  //     `<finalName>.motrix` container.
  //     For both BT layouts, pre-creating the engine `dir` also
  //     guarantees `aria2.addTorrent`'s metadata write
  //     (`<diskPath>/<sha1>.torrent`) succeeds at add time. Without
  //     this dir, the save fails silently; the resulting task gets a
  //     data-only `MetadataInfo` and the sqlite3 `task` row is never
  //     written, so the next pause hits a FOREIGN KEY violation when
  //     `task_progress` is upserted.
  //   - HTTP/FTP: `diskPath` IS the file aria2 will create
  //     (`dir = saveDir`, `out = <finalName>.motrix`). mkdir'ing it
  //     would race with aria2's open(2) for write — the path becomes
  //     a directory and aria2 fails the task with EISDIR. Pre-create
  //     `saveDir` instead so aria2's `dir` option is reachable.
  // aria2_motrix has the matching mkdirs on its side, so an mkdir
  // error here is logged but not fatal — defence-in-depth, not
  // single point of failure.
  const ensureDir = isTorrentLikeType(taskType) ? diskPath : effectiveSaveDir
  try {
    await mkdir(ensureDir, { recursive: true })
  } catch (cause) {
    log.warn(
      { err: cause, ensureDir, taskType },
      'pre-create disk slot failed; relying on aria2 to mkdirs'
    )
  }

  // 3. Build engine-agnostic create params per task family and dispatch
  // through the EngineAdapter. For HTTP, dir=saveDir and out uses the
  // incomplete suffix. For BT/magnet, dir=diskPath and `out` is absent;
  // parsed torrents additionally carry per-file output mappings. The adapter
  // is responsible for the aria2 wire shape.
  let pluginStaged: { commit: (cb: () => void) => void } | undefined
  let dispatchEngine: (reservedGid: string) => Promise<string>
  let directReplay: DirectReplayRecipe | null = null
  let canonicalUris = deriveUris(req)
  let resourceMetadata: DirectResourceMetadata | null = null
  let resourceProbeAttempted = false
  const metadataHeadersSupported = canMirrorAria2MetadataHeaders(
    deps.adapter.getFeatureReport?.()
  )
  // Shared by the HTTP and magnet branches — both dispatch through
  // createDownload with an identical log line; only their params differ.
  const dispatchCreateDownload =
    (params: CreateDownloadParams) =>
    async (reservedGid: string): Promise<string> => {
      params.gid = reservedGid
      log.info(
        {
          method: 'createDownload',
          uriCount: params.uris.length,
          gid: reservedGid,
          saveDir: params.saveDir,
          filename: params.filename,
          connections: params.connections,
        },
        'dispatching to engine'
      )
      return deps.adapter.createDownload(params)
    }

  if (req.type === 'http') {
    const clampedConnections =
      req.connections !== undefined
        ? Math.min(req.connections, engineSettings.maxConnectionPerServer)
        : undefined
    const headersRecord =
      req.headers.length > 0
        ? Object.fromEntries(req.headers.map((h) => [h.name, h.value]))
        : undefined

    const params: CreateDownloadParams = {
      uris: [...req.uris],
      // applyPathOverrides HTTP equivalent: dir = saveDir, out = <name>.motrix
      saveDir: effectiveSaveDir,
      filename: `${finalName}${INCOMPLETE_SUFFIX}`,
      performanceProfile: engineSettings.performanceProfile,
      userAgent: engineSettings.userAgent,
      connections: clampedConnections,
      headers: headersRecord,
      proxy: req.proxy,
      // Bridge cookie jar / referer; createDownload merges these raw AFTER
      // dir/out so a shell-supplied option can override (matches old order).
      extraEngineOptions: opts.extraEngineOptions,
    }
    let currentHttpDesiredName = desiredName
    const pickHttpName = async (nextDesiredName: string): Promise<void> => {
      if (nextDesiredName === currentHttpDesiredName) return
      finalName = await deps.finalNamePicker.pick(
        effectiveSaveDir,
        nextDesiredName
      )
      currentHttpDesiredName = nextDesiredName
      finalPath = path.join(effectiveSaveDir, finalName)
      diskPath = toTempPath(finalPath)
      params.filename = `${finalName}${INCOMPLETE_SUFFIX}`
    }

    // 3.4. Mux pre-resolve seam (desktop Add-Task path).
    // When both resolveToMux and dispatchMux are wired (bridge enabled +
    // youtube/bilibili URL), call the resolver BEFORE beforeCreate fires.
    // On a non-null mux pair, build an AdaptedMux reusing the already-computed
    // taskId/saveDir/finalName, then delegate to MuxPipeline and return — the
    // entire HTTP/beforeCreate/engine path is bypassed for this URL.
    // On null (non-resolver URL, bridge disabled, plugin not enabled) → fall
    // through to the unchanged HTTP path. No try/catch here: the factory owns
    // error handling (returns null on failure).
    if (deps.resolveToMux && deps.dispatchMux) {
      const uri = params.uris[0]
      if (uri) {
        const muxResult = await deps.resolveToMux(uri)
        if (muxResult) {
          const sanitizedHeaders = muxResult.headers
            ? stripHopByHopHeaders(muxResult.headers)
            : {}
          // DIAGNOSTIC: confirm the resolver returned distinct upos hosts and
          // that the gatekeeper header (Referer) survives sanitize into the
          // MediaJob. Logs HOSTS + header KEY presence only — never values.
          log.info(
            {
              taskId,
              videoHost: safeHost(muxResult.videoUrl),
              audioHost: safeHost(muxResult.audioUrl),
              sameUrl: muxResult.videoUrl === muxResult.audioUrl,
              container: muxResult.container,
              rawHeaderKeys: Object.keys(muxResult.headers ?? {}),
              hasReferer: 'Referer' in sanitizedHeaders,
              hasUserAgent: 'User-Agent' in sanitizedHeaders,
            },
            'mux resolve result'
          )
          // Prefer the resolver's human title over the URL-derived name (the
          // bvid BV1xxx is meaningless). Sanitize, append the container
          // extension, THEN dedup — the pick must run on the on-disk name.
          const titleBase = muxResult.title
            ? sanitizeFilename(muxResult.title).trim()
            : ''
          const muxFinalName = titleBase
            ? await deps.finalNamePicker.pick(
                effectiveSaveDir,
                ensureMediaExtension(titleBase, muxResult.container)
              )
            : finalName
          const adaptedMux: AdaptedMux = {
            kind: 'mux',
            taskId,
            saveDir: effectiveSaveDir,
            finalName: muxFinalName,
            videoUrl: muxResult.videoUrl,
            audioUrl: muxResult.audioUrl,
            sanitizedHeaders,
            container: muxResult.container,
            // Desktop path: no extension session context; sourceMeta is null.
            // MediaTaskCoordinator accepts SourceMeta (= BridgeSourceMeta | null).
            sourceMeta: null,
          }
          const muxDispatchResult = await deps.dispatchMux(adaptedMux)
          return {
            outcome: 'created',
            gid: muxDispatchResult.taskId,
            taskId: muxDispatchResult.taskId,
          }
        }
      }
    }

    // 3.5. Plan C plugin-hook chain (HTTP only — BT/magnet beforeCreate is
    // out of scope for T15; the orchestrator currently exposes only
    // `runBeforeCreateHttp`). When the orchestrator is wired we let eligible
    // plugins mutate the create params (uris, headers, proxy) and stage
    // metadata that will be committed in the same SQLite transaction as the
    // task row. Aborted chains skip the engine call entirely and surface
    // PluginRuntimeFault to the IPC caller.
    log.info(
      {
        taskId,
        hasOrchestrator: Boolean(deps.orchestrator),
        reqType: req.type,
        uris: req.uris,
      },
      'beforeCreate hook chain pre-check'
    )
    if (deps.orchestrator) {
      const ctxDto: BeforeCreateHttpContextDTO = {
        type: 'http',
        sourceUrl: params.uris[0] ?? '',
        uris: [...params.uris],
        saveDir: effectiveSaveDir,
        filename: desiredName,
        connections: req.connections,
        headers: req.headers.map((h) => ({ name: h.name, value: h.value })),
        proxy: req.proxy,
        createdBy: 'user',
        requestedAt: now,
      }
      const result = await deps.orchestrator.runBeforeCreateHttp(ctxDto, taskId)
      log.info(
        {
          taskId,
          aborted: result.aborted === true,
          rewrittenUris: result.aborted ? undefined : result.final.uris,
          contributors: result.aborted ? undefined : result.contributors,
        },
        'beforeCreate hook chain result'
      )
      if (result.aborted) {
        await deps.auditLog?.log({
          type: 'chain.abort',
          hook: 'beforeCreate',
          taskId,
          reason: result.reason,
        })
        throw new AppError(
          ErrorCode.PluginRuntimeFault,
          `plugin chain aborted: ${result.reason}`
        )
      }
      // Apply merged outputs back to the create params. mergeChain is
      // well-defined for the slot keys we care about; absent keys keep
      // the user's input intact. Conditionality matches the old code:
      //   - uris: ALWAYS overwritten (the chain always produces a final set)
      //   - headers: only when the chain produced headers (else keep req)
      //   - proxy: TRUTHY check (an empty-string proxy must NOT overwrite)
      params.uris = [...result.final.uris]
      if (result.final.headers.length > 0) {
        params.headers = Object.fromEntries(
          result.final.headers.map((h) => [h.name, h.value])
        )
      }
      if (result.final.proxy) {
        params.proxy = result.final.proxy
      }
      // Always emit chain.commit on a successful chain — a chain that
      // mutates only uris or proxy (no headers) still completes and
      // deserves an audit trail. Matches the sibling site in finalizeTask.
      await deps.auditLog?.log({
        type: 'chain.commit',
        hook: 'beforeCreate',
        taskId,
        headerContributors: result.contributors.headers,
        proxyContributor: result.contributors.proxy,
        uriContributor: result.contributors.uris,
        finalHeaderCount: result.final.headers.length,
      })
      if (deps.db) {
        const db = deps.db
        pluginStaged = {
          commit: (cb: () => void) =>
            result.staged.commitMetadata(db, taskId, cb),
        }
      }
    }

    assertSupportedHttpTaskProxy(params.proxy)

    const ambientMetadataProfile = metadataHeadersSupported
      ? resolveDirectResourceMetadataProfile(deps.adapter)
      : null
    const metadataRequestProfile = canApplyDirectResourceMetadataProfile(
      params,
      ambientMetadataProfile
    )
    if (metadataRequestProfile) {
      params.directResourceMetadataProfile = metadataRequestProfile
    }

    // The hook may replace the source URI. Rebase the non-explicit fallback
    // name onto that final URI before probing, so a failed/empty metadata
    // response cannot resurrect the original request's basename.
    if (!req.filename?.trim()) {
      await pickHttpName(uriBasename(params.uris[0]) ?? 'download')
    }

    // Probe only after mux has declined the URL and the plugin chain has
    // accepted and finalized its URI/header/proxy outputs. An aborted or
    // rewritten request must never probe the stale user-supplied target.
    // Manual names remain authoritative and skip filename discovery.
    if (
      !req.filename?.trim() &&
      params.uris.length === 1 &&
      metadataRequestProfile !== null &&
      deps.directResourceValidator?.probe
    ) {
      const uri = params.uris[0]
      if (uri) {
        resourceProbeAttempted = true
        try {
          const requestContext = directResourceRequestContext(
            params,
            appliedProxySnapshot ?? null
          )
          resourceMetadata = requestContext
            ? await deps.directResourceValidator.probe(uri, requestContext)
            : null
          const remoteName = resourceMetadata?.filename
            ? sanitizeRemoteFilename(resourceMetadata.filename)
            : null
          if (remoteName) await pickHttpName(remoteName)
        } catch {
          // Fetch/proxy errors may echo signed URLs or credentials. Keep the
          // optional fallback diagnostic limited to the non-secret host.
          log.debug(
            { host: safeHost(uri), taskId },
            'remote resource metadata probe skipped'
          )
        }
      }
    }

    // Persist only the request-shape capability needed to decide whether a
    // future retry can be reconstructed from TaskInstance. Paths and URIs are
    // already canonical fields on the instance; modifier VALUES remain
    // engine-call-only so credentials never enter motrix.db.
    directReplay = buildDirectReplayRecipe(
      params,
      ambientMetadataProfile === null
    )
    if (
      directReplay.replayability === 'uri-only' &&
      metadataRequestProfile !== null &&
      deps.directResourceValidator &&
      params.uris.length === 1
    ) {
      try {
        const uri = params.uris[0] as string
        const requestContext = directResourceRequestContext(
          params,
          appliedProxySnapshot ?? null
        )
        const resourceValidator = resourceProbeAttempted
          ? resourceMetadata?.validator
          : requestContext
            ? await deps.directResourceValidator.capture(uri, requestContext)
            : null
        if (resourceValidator) {
          directReplay = { ...directReplay, resourceValidator }
        }
      } catch (error) {
        // Validator capture is an optional safety enhancement. A HEAD failure
        // must not make an otherwise valid download impossible to create.
        log.debug(
          { err: error, taskId },
          'direct resource validator capture skipped'
        )
      }
    }
    canonicalUris = [...params.uris]
    dispatchEngine = dispatchCreateDownload(params)
  } else if (req.payload.kind === 'torrent-base64') {
    // Torrent bytes were decoded earlier for name/private extraction; they
    // are always present on the torrent-base64 path.
    const params: AddTorrentParams = {
      metadata: torrentBytes ?? decodeBase64ToBytes(req.payload.base64),
      // applyPathOverrides BT equivalent: dir = diskPath, out dropped.
      saveDir: diskPath,
      // CREATE-PATH +1: req indices are 0-based; aria2 select-file is
      // 1-based, and addTorrent serializes selectedFiles with a raw join.
      selectedFiles: req.selectedFiles.map((i) => i + 1),
      outputFilePaths: btStoragePlan?.outputFilePaths,
      dlLimit: req.dlLimit,
      ulLimit: req.ulLimit,
      seedRatio: req.seedRatio,
      // Replaces the old inline `options['bt-tracker'] = ''` set.
      isPrivate: isPrivateFromTorrent,
      ...(parsedBtLayout && shouldPrioritizeBtPreviewPieces(parsedBtLayout)
        ? { prioritizePreviewPieces: true }
        : {}),
    }
    dispatchEngine = async (reservedGid) => {
      params.gid = reservedGid
      // Never log `params.metadata` itself: pino would expand the whole
      // torrent byte array into a multi-megabyte JSON line.
      const { metadata, ...loggableParams } = params
      log.info(
        {
          method: 'addTorrent',
          metadataBytes: metadata.length,
          params: loggableParams,
        },
        'dispatching to engine'
      )
      return deps.adapter.addTorrent(params)
    }
  } else {
    // Magnet: BT-typed but no metadata bytes, so it CANNOT use addTorrent.
    // Reproduce the old `toBt` magnet wire (addUri with a BT-ish option map +
    // dir=diskPath, no out) through createDownload + extraEngineOptions.
    const magnetEngineOpts: Record<string, string> = {}
    if (req.selectedFiles.length > 0) {
      magnetEngineOpts['select-file'] = req.selectedFiles
        .map((i) => i + 1)
        .join(',')
    }
    if (req.dlLimit !== undefined) {
      magnetEngineOpts['max-download-limit'] = `${req.dlLimit}K`
    }
    if (req.ulLimit !== undefined) {
      magnetEngineOpts['max-upload-limit'] = `${req.ulLimit}K`
    }
    if (req.seedRatio !== undefined) {
      magnetEngineOpts['seed-ratio'] = String(req.seedRatio)
    }
    const params: CreateDownloadParams = {
      uris: [req.payload.uri],
      // dir = diskPath; NO filename → createDownload emits no `out`.
      saveDir: diskPath,
      // Spread order: magnet opts first, then shell-supplied opts (which
      // merged LAST in the old code and could override). createDownload then
      // merges extraEngineOptions after `dir`, so the final aria2 map is
      // { dir: diskPath, ...magnetEngineOpts, ...opts.extraEngineOptions } —
      // byte-identical to the old toBt + applyPathOverrides + opts merge.
      extraEngineOptions: {
        ...magnetEngineOpts,
        ...(opts.extraEngineOptions ?? {}),
      },
    }
    dispatchEngine = dispatchCreateDownload(params)
  }

  // Resolve readiness before publishing a durable create intent. A rejected
  // cold-start gate must not leave a queued task that was never dispatched.
  if (req.type === 'http') {
    assertAppliedProxyCurrent?.()
    deps.assertEngineReady?.()
  } else if (deps.waitForEngineReady) {
    await deps.waitForEngineReady()
  }

  const gid = newEngineTaskId(deps.createEngineTaskId, 'createTask')
  // 5. Build a fully-populated durable owner before engine dispatch.
  const isBtLike = isTorrentLikeType(taskType)
  const taskKind: TaskKind = isBtLike ? TaskKind.Bt : TaskKind.Direct
  const phase: TaskInstancePhase = isBtLike
    ? TaskInstancePhase.BtDownload
    : TaskInstancePhase.HttpDownload
  const primaryInstance: TaskInstance = {
    instanceId: `primary:${taskId}`,
    motrixId: taskId,
    gid,
    phase,
    status: TaskStatus.Queued,
    progress: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    uploadedBytes: 0,
    diskPath,
    transitionPhase: TransitionPhase.Idle,
    uris: canonicalUris,
    uriHash: null,
    payload: btStoragePlan
      ? btStoragePayload(btStoragePlan.layout)
      : directReplay
        ? { directReplay }
        : {},
    createdAt: now,
    updatedAt: now,
  }

  const task: DownloadTask = makeDownloadTask({
    id: taskId,
    engineTaskId: gid,
    name: finalName,
    kind: taskKind,
    type: taskType,
    saveDir: effectiveSaveDir,
    createdAt: now,
    updatedAt: now,
    uris: canonicalUris,
    dlLimit: req.type === 'bt' ? (req.dlLimit ?? 0) : 0,
    ulLimit: req.type === 'bt' ? (req.ulLimit ?? 0) : 0,
    filename: finalName,
    diskPath,
    finalPath,
    finalName,
    torrentMetaPath,
    infoHash: btInfoHash,
    // For BT/Magnet, seed bt.isPrivate at creation time so SessionManager.save()
    // persists is_private to db. Other bt fields are filled in by the next poll
    // cycle via translateBtExtension; mergeTask preserves isPrivate via the
    // saved.isPrivate injection wired in Task 4.
    bt: isBtLike
      ? makeDefaultBtExtension({
          isPrivate: isPrivateFromTorrent,
          selectedFiles: req.type === 'bt' ? req.selectedFiles : [],
        })
      : undefined,
    // Provenance: defaults to 'user'. Bridge receiver passes 'bridge' +
    // BridgeSourceMeta via CreateTaskOptions to attribute rows correctly.
    source: opts.source ?? 'user',
    sourceMeta: opts.sourceMeta ?? null,
    instances: [primaryInstance],
  })
  const createReservedTask = async (): Promise<TaskCreateSuccessResult> => {
    deps.taskManager.reserveEngineTaskId(gid)

    const persistParent = async (): Promise<void> => {
      await deps.persistTask?.(task)
    }
    const hasDurableIntent = Boolean(
      deps.persistTask || deps.parentTaskCreated || pluginStaged
    )
    const rollbackDurableIntent = async (): Promise<boolean> => {
      if (!hasDurableIntent) return true
      if (!deps.rollbackTaskCreation) return false
      try {
        await deps.rollbackTaskCreation(task.id)
        return true
      } catch (rollbackError) {
        log.error(
          { err: rollbackError, taskId: task.id },
          'failed to roll back durable create intent'
        )
        return false
      }
    }
    const announceOwnedTask = (): void => {
      deps.activityRecorder.recordSubmitted({
        taskId: task.id,
        occurredAt: task.createdAt,
      })
      deps.publishTaskUpdate()
    }

    try {
      if (deps.parentTaskCreated) {
        await deps.parentTaskCreated(task, persistParent)
      } else {
        await persistParent()
      }
      // Plugin metadata must be durable before engine dispatch too. The parent
      // row already crossed its rejecting barrier above; this synchronous
      // transaction flushes only the staged hook metadata.
      pluginStaged?.commit(() => {})
    } catch (cause) {
      const rolledBack = await rollbackDurableIntent()
      if (rolledBack) {
        deps.taskManager.releaseEngineTaskIdReservation(gid)
      } else {
        // A side-effect-then-throw persistence implementation may have left a
        // recoverable parent. Keep an in-process owner instead of an unbounded
        // ownerless reservation.
        deps.taskManager.add(task)
        announceOwnedTask()
      }
      throw cause
    }

    // Silent reservation owner: SessionManager snapshots now see the durable
    // intent, while isEngineTaskIdRetired(gid) continues to block poll merges
    // until the adapter confirms the caller-reserved GID.
    deps.taskManager.setReservedEngineTaskOwner(task.id, task, gid)

    try {
      if (req.type === 'http') {
        deps.assertEngineReady?.()
        assertAppliedProxyCurrent?.()
      }
      const actualGid = await dispatchEngine(gid)
      if (actualGid.toLowerCase() !== gid.toLowerCase()) {
        throw new Error(
          `Engine returned gid ${actualGid} instead of reserved gid ${gid}`
        )
      }
      // Ordinary set claims the reservation and opens authoritative polling.
      deps.taskManager.add(task)
      log.info({ gid, taskId, finalName }, 'engine accepted task')
    } catch (cause) {
      log.error({ err: cause, taskId, finalName }, 'engine rejected task')

      try {
        await deps.adapter.forceRemoveTask(gid)
      } catch (cleanupError) {
        log.warn(
          { err: cleanupError, gid, taskId },
          'create compensation force-remove failed'
        )
      }
      let cleanupComplete = false
      try {
        await deps.adapter.removeDownloadResult(gid)
        cleanupComplete = true
      } catch (cleanupError) {
        cleanupComplete = false
        log.error(
          { err: cleanupError, gid, taskId },
          'create compensation result cleanup failed'
        )
      }

      if (cleanupComplete) {
        // remove() moves the indexed provisional owner into the retired shield;
        // consume the still-live reservation before awaiting parent rollback.
        deps.taskManager.remove(task.id)
        deps.taskManager.retireEngineTaskIdReservation(gid)
        const rolledBack = await rollbackDurableIntent()
        if (rolledBack) {
          deps.publishTaskUpdate()
          throw cause
        }
      }

      // The engine outcome or durable rollback is uncertain. Promote the silent
      // candidate to an ordinary owner so every live GID has the same public
      // task identity and recovery can reconcile it after restart.
      deps.taskManager.add(task)
      announceOwnedTask()
      throw cause
    }

    announceOwnedTask()

    // Push the new snapshot so the renderer's UI shows the task
    // immediately — without this, the new task is invisible until the
    // next polling tick (and even then, if the polled fields match the
    // initial Queued/zero state, handlePolledTasks's dirty guard might
    // not emit either).

    return { outcome: 'created', gid, taskId }
  }

  return deps.runTaskMutation
    ? deps.runTaskMutation([taskId], createReservedTask)
    : createReservedTask()
}

// ─── Helpers ──────────────────────────────────────────────────

function deriveTaskType(req: TaskCreateRequest): TaskType {
  if (req.type === 'http') return TaskType.Http
  return req.payload.kind === 'magnet' ? TaskType.Magnet : TaskType.Bt
}

function deriveUris(req: TaskCreateRequest): string[] {
  if (req.type === 'http') return [...req.uris]
  if (req.payload.kind === 'magnet') return [req.payload.uri]
  return []
}

function deriveDesiredName(
  req: TaskCreateRequest,
  torrentInfoName: string | null
): string {
  if (req.type === 'http') {
    const fname = req.filename?.trim()
    if (fname) return fname
    const fromUri = uriBasename(req.uris[0])
    if (fromUri) return fromUri
    return 'download'
  }
  // BT / magnet priority: explicit displayName > torrent info.name >
  // magnet dn= > infoHash > literal fallback.
  const display = req.displayName?.trim()
  if (display) return display
  if (torrentInfoName) return torrentInfoName
  if (req.payload.kind === 'magnet') {
    const fromMagnet = extractMagnetDn(req.payload.uri)
    if (fromMagnet) return fromMagnet
    return extractMagnetInfoHash(req.payload.uri) ?? 'magnet'
  }
  return 'torrent'
}

function directResourceRequestContext(
  params: Pick<
    CreateDownloadParams,
    | 'headers'
    | 'proxy'
    | 'extraEngineOptions'
    | 'userAgent'
    | 'directResourceMetadataProfile'
  >,
  appliedProxySnapshot: AppliedDownloadProxySnapshot
): DirectResourceRequestOptions | null {
  // Passthrough engine options can add cookies, a referer, headers, or other
  // request semantics the metadata client cannot reconstruct safely.
  if (
    (params.extraEngineOptions &&
      Object.keys(params.extraEngineOptions).length > 0) ||
    params.directResourceMetadataProfile !== DIRECT_RESOURCE_METADATA_PROFILE ||
    !canRepresentDirectResourceHeaders(params.headers)
  ) {
    return null
  }
  const options: DirectResourceRequestOptions = {}
  if (params.headers) options.headers = params.headers
  if (params.userAgent !== undefined) options.userAgent = params.userAgent
  if (appliedProxySnapshot === null) return null
  const globalProxy = appliedProxySnapshot

  const explicitProxy = params.proxy?.trim()
  if (explicitProxy) {
    // aria2's task-level all-proxy accepts HTTP proxy syntax only. In
    // particular, probing through Undici's SOCKS agent before aria2 rejects
    // the task would expose request headers to a route the download never
    // uses. Invalid or SOCKS task proxies therefore disable metadata I/O.
    const metadataProxy = normalizeProxyUrl(explicitProxy)
    if (!metadataProxy || metadataProxy.protocol === 'socks5:') return null
    options.proxy = explicitProxy
    // aria2's task-level all-proxy overrides only the proxy endpoint. Its
    // global no-proxy list still applies, so metadata discovery must inherit
    // the same bypass decision or it could send task headers to a proxy while
    // the actual download connects directly.
    if (globalProxy.noProxy) {
      options.noProxy = globalProxy.noProxy
    }
    return options
  }

  if (globalProxy.proxy) options.proxy = globalProxy.proxy
  if (globalProxy.noProxy) options.noProxy = globalProxy.noProxy
  return options
}

function resolveDirectResourceMetadataProfile(
  adapter: EngineAdapter
): DirectResourceMetadataProfile | null {
  if (!adapter.getDirectResourceMetadataProfile) return null
  try {
    return adapter.getDirectResourceMetadataProfile()
  } catch {
    return null
  }
}

function canApplyDirectResourceMetadataProfile(
  params: Pick<CreateDownloadParams, 'uris' | 'extraEngineOptions'>,
  profile: DirectResourceMetadataProfile | null
): DirectResourceMetadataProfile | null {
  if (
    profile === null ||
    (params.extraEngineOptions &&
      Object.keys(params.extraEngineOptions).length > 0) ||
    !params.uris.every(isCredentialFreeHttpUri)
  ) {
    return null
  }
  return profile
}

function isCredentialFreeHttpUri(uri: string): boolean {
  try {
    const parsed = new URL(uri)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === ''
    )
  } catch {
    return false
  }
}

function assertSupportedHttpTaskProxy(proxy: string | undefined): void {
  const value = proxy?.trim()
  if (
    !value ||
    (normalizeAria2TaskProxyUrl(value) &&
      extractAria2ProxyCredentials(value) !== null)
  ) {
    return
  }
  throw new AppError(
    ErrorCode.TaskCreateFailed,
    'Task proxy must use aria2-compatible HTTP or HTTPS syntax; configure SOCKS5 as the global download proxy instead'
  )
}

function uriBasename(uri: string | undefined): string | null {
  if (!uri) return null
  try {
    const url = new URL(uri)
    const parts = url.pathname.split('/').filter(Boolean)
    const last = parts[parts.length - 1]
    if (!last) return null
    try {
      return sanitizeRemoteFilename(decodeURIComponent(last))
    } catch {
      return sanitizeRemoteFilename(last)
    }
  } catch {
    return null
  }
}

/** Host of a URL for diagnostics, or a marker if it doesn't parse. */
function safeHost(u: string): string {
  try {
    return new URL(u).host
  } catch {
    return '<unparseable>'
  }
}

function extractMagnetDn(uri: string): string | null {
  const match = uri.match(/[?&]dn=([^&]+)/)
  if (!match) return null
  try {
    return decodeURIComponent(match[1].replace(/\+/g, ' '))
  } catch {
    return match[1]
  }
}

function decodeBase64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, 'base64'))
}
