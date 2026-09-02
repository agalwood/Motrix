import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { AdaptedMux } from '@core/bridge-receiver/submit-download-adapter'
import type { DnsFallbackConsumer } from '@core/engine/aria2/dns-fallback'
import { dnsModeToAsyncDns } from '@core/engine/aria2/dns-fallback'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import type { EngineSupervisor } from '@core/engine/engine-supervisor'
import { ENGINE_READY_TIMEOUT_MS } from '@core/engine/engine-supervisor'
import type { EventBus } from '@core/events/event-bus'
import type { GeoIPManager } from '@core/geoip/geo-ip-manager'
import { createUpdateGeoIPDatabaseHandler } from '@core/geoip/update-geo-ip-database'
import { getLogger } from '@core/logger'
import { publishEngineRestartRequired } from '@core/notifications/engine-restart-required'
import type { NotificationCenter } from '@core/notifications/notification-center'
import type { CapabilityHost } from '@core/plugin/capabilities/interface'
import type { GrantsManager } from '@core/plugin/grants/grants-manager'
import { HookAuditLog } from '@core/plugin/hooks/audit-log'
import { HookOrchestrator } from '@core/plugin/hooks/hook-orchestrator'
import type { ActivationDispatcher } from '@core/plugin/host/activation-dispatcher'
import type { PluginHost } from '@core/plugin/host/plugin-host'
import {
  downloadGithubMoext,
  parseGithubSpec,
} from '@core/plugin/install/github-fetcher'
import type { PluginInstaller } from '@core/plugin/install/plugin-installer'
import {
  buildRegistryExpectation,
  type RegistryExpectation,
} from '@core/plugin/install/registry-expectation'
import type { SourceInput } from '@core/plugin/install/source-resolver'
import { downloadUrlMoext } from '@core/plugin/install/url-fetcher'
import type { PluginRegistry } from '@core/plugin/plugin-registry'
import type { RegistryClient } from '@core/plugin/registry/registry-client'
import { downloadRegistryMoext } from '@core/plugin/registry/registry-fetcher'
import { scanForUpdates } from '@core/plugin/registry/update-scan'
import type { PluginStateStore } from '@core/plugin/state/plugin-state-store'
import type { BuiltinUpdater } from '@core/plugin/update/builtin-updater'
import {
  type AppliedDownloadProxyPolicy,
  UNAVAILABLE_APPLIED_DOWNLOAD_PROXY_POLICY,
} from '@core/proxy/applied-download-proxy-policy'
import type { MotrixDatabase } from '@core/session/motrix-database'
import type { SessionManager } from '@core/session/session-manager'
import type { SettingsManager } from '@core/settings/settings-manager'
import {
  pauseTask,
  reAddTask,
  removeTask,
  resumeTask,
  runBulkTaskAction,
  stopSeedingTask,
  toBulkTaskCommandResult,
} from '@core/task/actions'
import type {
  TaskActionDeps,
  TaskTransitionRecordInput,
} from '@core/task/actions/shared'
import {
  acquireBtInfoHashAdmission,
  inspectBtDuplicate,
  taskCreateConflictResult,
} from '@core/task/bt-duplicate-policy'
import { parseBtFileLayout } from '@core/task/bt-storage-layout'
import {
  type CreateTaskDeps,
  handleCreateTask,
} from '@core/task/create-task-handler'
import { DirectResourceValidatorService } from '@core/task/direct-resource-validator'
import type { FileCleanupService } from '@core/task/file-cleanup-service'
import type { FinalNamePicker } from '@core/task/final-name-picker'
import type { OccurrenceDispatcher } from '@core/task/occurrences/occurrence-dispatcher'
import type { TaskManager } from '@core/task/task-manager'
import type { TorrentMetaStore } from '@core/task/torrent-meta-store'
import type { MagnetTracker } from '@core/torrent/magnet-tracker'
import { swapMagnetMetadataForBt } from '@core/torrent/swap-magnet-metadata-for-bt'
import type { TorrentParser } from '@core/torrent/torrent-parser'
import type { TrackerManager } from '@core/tracker'
import type { NatManager } from '@motrix/nat'
import { AppError, ErrorCode } from '@shared/errors'
import { EXTERNAL_URLS } from '@shared/external-urls'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import type { CommandHandlerMap } from '@shared/protocol/handler-types'
import {
  type TaskCreateCommandResult,
  taskCreateRequestSchema,
  torrentBatchCreateOptionsSchema,
} from '@shared/schemas/add-task'
import {
  removeTasksPayloadSchema,
  taskIdsPayloadSchema,
} from '@shared/schemas/bulk-task-command'
import { closeCurrentWindowSchema } from '@shared/schemas/close-current-window'
import { checkPluginUpdatesPayloadSchema } from '@shared/schemas/plugin-update'
import { REGISTRY_PLUGIN_ID_RE } from '@shared/schemas/registry'
import { removeTaskPayloadSchema } from '@shared/schemas/remove-task'
import { showAddTaskWindowSchema } from '@shared/schemas/show-add-task-window'
import {
  CLI_INSTALL_PACKAGE_MANAGERS,
  type CliInstallRequest,
} from '@shared/types/cli-tool'
import { EngineRecoveryAction } from '@shared/types/engine'
import type { ProxySettings } from '@shared/types/settings'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { canRetryMagnetMetadata } from '@shared/types/task-actions'
import type { TaskActivityRecorder } from '@shared/types/task-activity'
import type { TaskOccurrence } from '@shared/types/task-occurrence'
import {
  BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
  shell,
} from 'electron'
import { z } from 'zod'
import type { BridgeManager } from '../bridge/bridge-manager'
import type { CliToolService } from '../cli/cli-tool-service'
import { MenuContextPatchSchema } from '../commands/context-schema'
import type { ContextStore } from '../commands/context-store'
import type { UpdateManager } from '../core/update-manager'
import {
  enableAppImageIntegrationFromSettings,
  reconcileAppImageIntegrationFromSettings,
  removeAppImageIntegrationFromSettings,
} from '../platform/appimage-integration-host'
import { syncAutoLaunch } from '../platform/auto-launch'
import { setLinuxDefaultTorrentHandler } from '../platform/linux-default-apps'
import type { createProtocolManager } from '../platform/protocol-manager'
import { resolveWindowsDefaultAppsSettingsUrl } from '../platform/windows-default-apps'
import type { createMainProxyApplier } from '../proxy/wiring'
import type { WindowManager } from '../window/window-manager'
import { createRevealInFolderHandler } from './commands/reveal-in-folder'
import { createSetSelectedFilesHandler } from './commands/set-selected-files'
import { NatCommandHandlers } from './nat-commands'
import { applyNatPrivacyGate } from './nat-settings-gate'
import { registerTrustedIpcHandler } from './trusted-ipc'

const cliInstallRequestSchema = z
  .object({ packageManager: z.enum(CLI_INSTALL_PACKAGE_MANAGERS) })
  .strict()

export interface CommandContext {
  cliToolService: Pick<CliToolService, 'install'>
  supervisor: EngineSupervisor
  /** Session latch of the auto DNS fallback — reset when dnsMode changes. */
  dnsFallback?: Pick<DnsFallbackConsumer, 'reset'>
  /**
   * Late-binds the DNS fallback consumer's task retry to the same
   * `reAddTask` deps bundle the ReAddTasks command uses, so the two
   * paths cannot drift. Called synchronously during handler construction.
   */
  bindTaskRetry?: (fn: (taskId: string) => Promise<unknown>) => void
  sessionManager: SessionManager
  settingsManager: SettingsManager
  protocolManager: ReturnType<typeof createProtocolManager>
  windowManager: WindowManager
  natManager: NatManager
  torrentParser: TorrentParser
  adapter: EngineAdapter
  taskManager: TaskManager
  updateManager: UpdateManager
  /**
   * Startup barrier: resolves once engine start + session restore have
   * settled (success or failure). createTask awaits it (after engine-ready)
   * before dispatching, so a create racing restore() can't be wiped by its
   * clear() + orphan re-adopt. Optional for back-compat with test contexts.
   */
  waitForTasksReady?: () => Promise<void>
  trackAsyncWork?: <T>(operation: () => Promise<T>) => Promise<T>
  trackerManager: TrackerManager
  contextStore: ContextStore
  finalNamePicker: FinalNamePicker
  torrentMetaStore: TorrentMetaStore
  fileCleanupService: FileCleanupService
  eventBus: EventBus
  notificationCenter: Pick<NotificationCenter, 'notify'>
  motrixDatabase: MotrixDatabase
  geoipManager: GeoIPManager
  proxyApplier: ReturnType<typeof createMainProxyApplier>
  appliedDownloadProxyPolicy: AppliedDownloadProxyPolicy
  pluginRegistry: PluginRegistry
  pluginStateStore: PluginStateStore
  pluginHost: PluginHost
  pluginInstaller: PluginInstaller
  registryClient: RegistryClient
  hostVersion: string
  builtinUpdater: BuiltinUpdater
  overlayDir: string
  pluginGrants: GrantsManager
  capabilityHost: CapabilityHost
  userDataDir: string
  pluginsDir: string
  pluginActivation: ActivationDispatcher
  bridgeManager: BridgeManager
  magnetTracker: MagnetTracker
  activityRecorder: TaskActivityRecorder
  persistTask: NonNullable<TaskActionDeps['persistTask']>
  /**
   * Persist a task and (when non-null) its terminal occurrence in a single
   * durable transaction — used INSTEAD OF `persistTask` whenever a status
   * transition qualifies for one. Optional; absence degrades every task
   * action below to plain `persistTask` (no occurrence emitted).
   */
  persistTaskWithOccurrence?: (
    task: DownloadTask,
    occurrence: TaskOccurrence | null
  ) => Promise<void>
  /** Delivers a just-committed terminal occurrence to in-process consumers. */
  occurrenceDispatcher?: Pick<OccurrenceDispatcher, 'dispatch'>
  recordTransition: (input: TaskTransitionRecordInput) => void | Promise<void>
  deleteParentTasks: NonNullable<TaskActionDeps['deleteParentTasks']>
  runTaskMutation: NonNullable<TaskActionDeps['runTaskMutation']>
  parentTaskCreated: (
    task: DownloadTask,
    persistParent: () => void | Promise<void>
  ) => Promise<void>
  /** Coalesced / immediate TaskUpdated publication (TaskUpdatePublisher). */
  publishTaskUpdate: TaskActionDeps['publishTaskUpdate']
  publishTaskUpdateNow: TaskActionDeps['publishTaskUpdateNow']
}

function sendToAddTaskWindow(
  windowManager: WindowManager,
  channel: string,
  ...args: unknown[]
): void {
  windowManager.open('add-task')
  const win = windowManager.get('add-task')
  if (win && !win.isDestroyed()) {
    // Delay to ensure window renderer has attached event listeners
    setTimeout(() => {
      win.webContents.send(channel, ...args)
    }, 100)
  }
}

// biome-ignore lint/suspicious/noExplicitAny: sender is typed at registration
type WebContents = any

export function buildCommandHandlers(ctx: CommandContext): CommandHandlerMap {
  const {
    cliToolService,
    supervisor,
    dnsFallback,
    bindTaskRetry,
    sessionManager,
    settingsManager,
    protocolManager,
    windowManager,
    natManager,
    torrentParser,
    magnetTracker,
    adapter,
    taskManager,
    updateManager,
    waitForTasksReady,
    trackerManager,
    contextStore,
    finalNamePicker,
    torrentMetaStore,
    fileCleanupService,
    eventBus,
    notificationCenter,
    appliedDownloadProxyPolicy,
    motrixDatabase,
    geoipManager,
    proxyApplier,
    pluginRegistry,
    pluginStateStore,
    pluginHost,
    pluginInstaller,
    registryClient,
    hostVersion,
    builtinUpdater,
    overlayDir,
    pluginGrants,
    capabilityHost,
    userDataDir,
    pluginsDir,
    pluginActivation,
    bridgeManager,
    activityRecorder,
    persistTask,
    persistTaskWithOccurrence,
    occurrenceDispatcher,
    recordTransition,
    deleteParentTasks,
    runTaskMutation,
    parentTaskCreated,
    publishTaskUpdate,
    publishTaskUpdateNow,
  } = ctx

  // Plan C plugin-hook plumbing: instantiate the orchestrator + audit log
  // once and feed them into createDeps so handleCreateTask's beforeCreate
  // chain fires. Without this, every plugin's beforeCreate hook is silently
  // skipped and the user-supplied URL is dispatched to aria2 unchanged.
  const hookAuditLog = new HookAuditLog(
    path.join(userDataDir, 'plugin-audit', 'hooks.ndjson')
  )
  const hookOrchestrator = new HookOrchestrator({
    host: pluginHost,
    hookTimeoutMs: { series: 10_000, parallel: 30_000 },
    pluginsDir,
    pluginStorageRootFor: (pluginId) =>
      path.join(pluginsDir, pluginId, 'storage'),
    auditLog: hookAuditLog,
  })

  const createDeps: CreateTaskDeps = {
    adapter,
    directResourceValidator: new DirectResourceValidatorService(),
    directResourceProxyPolicy:
      appliedDownloadProxyPolicy ?? UNAVAILABLE_APPLIED_DOWNLOAD_PROXY_POLICY,
    settingsManager,
    finalNamePicker,
    torrentMetaStore,
    taskManager,
    eventBus,
    publishTaskUpdate,
    activityRecorder,
    orchestrator: hookOrchestrator,
    auditLog: hookAuditLog,
    db: motrixDatabase.database,
    persistTask,
    parentTaskCreated,
    rollbackTaskCreation: (taskId: string) =>
      sessionManager.runExclusivePersistence(() =>
        deleteParentTasks([taskId], () => {
          motrixDatabase.deleteTask(taskId)
        })
      ),
    runTaskMutation,
    // Cold-start gate: engine ready AND startup restore settled. A create
    // racing SessionManager.restore() gets wiped by its clear() and the gid
    // re-adopted as an engine orphan — see startupTasksSettled in main/index.
    waitForEngineReady: async () => {
      await supervisor.waitUntilReady(ENGINE_READY_TIMEOUT_MS)
      await waitForTasksReady?.()
    },
    assertEngineReady: () => supervisor.assertReady(),
    // Lazy closures over bridgeManager.current so command-registration order
    // vs bridge bootstrap order never matters. When the bridge is disabled or
    // not yet started, resolveToMux returns null → HTTP fallback; dispatchMux
    // is only called when resolveToMux returns non-null (seam gates on both).
    // By design the desktop path passes NO cookie header (2nd arg omitted):
    // the app has no browser bilibili session, so desktop paste stays ≤480p.
    // Bilibili HD comes via the extension submit path, which carries cookies.
    resolveToMux: (url: string) =>
      bridgeManager.current?.resolveToMux(url) ?? Promise.resolve(null),
    // A resolver can produce a mux pair WITHOUT ffmpeg (it only queries APIs),
    // but actually downloading it needs the MuxPipeline, which exists only when
    // ffmpeg is available. Throw a clear, actionable error instead of a
    // TypeError when the pipeline is absent (bridge disabled / no ffmpeg) —
    // mirrors the extension path's "ffmpeg unavailable" guard in BridgeReceiver.
    dispatchMux: (adapted: AdaptedMux) => {
      const mux = bridgeManager.current?.muxPipeline
      if (!mux) {
        throw new AppError(
          ErrorCode.EngineFeatureUnavailable,
          'ffmpeg is required to download this video: its video and audio are separate streams that must be muxed. Install ffmpeg (or set MOTRIX_FFMPEG_BIN) and restart Motrix.'
        )
      }
      return mux.dispatch(adapted)
    },
  }

  // Lazy closure over bridgeManager.current, mirroring resolveToMux/dispatchMux:
  // a media task (Mux/Hls) has engineTaskId '' and no aria2 handle, so pause/
  // resume act on the coordinator's live segment gids instead. Returns [] when
  // the bridge/coordinator is absent — pause/resume then reports a clear
  // "can't be paused" error rather than crashing on an empty gid.
  const getMediaSegmentGids = (taskId: string): string[] =>
    bridgeManager.current?.getMediaSegmentGids(taskId) ?? []

  const log = getLogger('commands')

  // Shared by the singular AND plural task command handlers below — one
  // deps bundle per action family so the two arities cannot drift.
  const pauseResumeDeps = {
    taskManager,
    adapter,
    eventBus,
    log,
    getMediaSegmentGids,
    persistTask,
    persistTaskWithOccurrence,
    occurrenceDispatcher,
    recordTransition,
    runTaskMutation,
    publishTaskUpdate,
    publishTaskUpdateNow,
  }
  const stopSeedingDeps = {
    taskManager,
    adapter,
    eventBus,
    log,
    persist: persistTask,
    persistTaskWithOccurrence,
    occurrenceDispatcher,
    recordTransition,
    runTaskMutation,
    publishTaskUpdate,
    publishTaskUpdateNow,
  }
  const reAddDeps = {
    taskManager,
    adapter,
    eventBus,
    log,
    torrentMetaStore,
    persistTask,
    recordTransition,
    runTaskMutation,
    publishTaskUpdate,
    publishTaskUpdateNow,
    getDirectResourceProxyOptions: () => {
      const snapshot = (
        appliedDownloadProxyPolicy ?? UNAVAILABLE_APPLIED_DOWNLOAD_PROXY_POLICY
      ).snapshot()
      return snapshot
        ? { ...snapshot, userAgent: settingsManager.getEngine().userAgent }
        : null
    },
    directResourceProxyPolicy:
      appliedDownloadProxyPolicy ?? UNAVAILABLE_APPLIED_DOWNLOAD_PROXY_POLICY,
  }
  createDeps.reuseExistingBt = (taskId) => reAddTask(taskId, reAddDeps)
  // The DNS fallback consumer retries through the same deps bundle as
  // Commands.ReAddTasks so the automatic and user-initiated paths match.
  bindTaskRetry?.((id) => reAddTask(id, reAddDeps))
  const removeDeps = {
    taskManager,
    adapter,
    log,
    fileCleanupService,
    torrentMetaStore,
    eventBus,
    db: motrixDatabase,
    magnetTracker,
    taskPersistence: sessionManager,
    publishTaskUpdate,
    publishTaskUpdateNow,
    // Tear down the coordinator run for a media task (engineTaskId '') so
    // removing it never orphans the segment downloaders + ffmpeg.
    cancelMedia: (id: string) =>
      bridgeManager.current?.cancelMedia(id) ?? Promise.resolve(),
    deleteParentTasks,
    runTaskMutation,
  }

  const updatePluginConfigSchema = z.object({
    pluginId: z.string().min(1),
    patch: z.record(z.string(), z.unknown()),
  })
  const engineRecoverySchema = z.object({
    action: z.enum(EngineRecoveryAction),
    expectedPid: z.number().int().positive().optional(),
  })

  const installPluginPayloadSchema = z.discriminatedUnion('sourceType', [
    z.object({ sourceType: z.literal('github'), spec: z.string().min(1) }),
    z.object({ sourceType: z.literal('url'), url: z.string().min(1) }),
    z.object({
      sourceType: z.literal('local'),
      absPath: z.string().min(1),
      fileHash: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    z.object({
      sourceType: z.literal('registry'),
      pluginId: z.string().regex(REGISTRY_PLUGIN_ID_RE),
    }),
  ])
  type InstallPluginPayload = z.infer<typeof installPluginPayloadSchema>
  type FetchedInstallPayload = Exclude<
    InstallPluginPayload,
    { sourceType: 'registry' }
  >

  const confirmPluginInstallPayloadSchema = z.object({
    stagingId: z.string().min(1),
    grants: z.record(z.string(), z.enum(['granted', 'denied'])),
  })

  const builtinUpdatePayloadSchema = z.object({
    pluginId: z.string().regex(REGISTRY_PLUGIN_ID_RE),
  })
  const builtinStagingPayloadSchema = z.object({
    stagingId: z.string().min(1),
  })

  // deactivate → rescan → reactivate; a failed reactivation is NOT an
  // install failure — the overlay is on disk and effective next launch.
  //
  // knownWasActive lets a caller that must deactivate BEFORE calling this
  // function (RevertBuiltinToBundled — deactivate has to happen before the
  // overlay `rm` so the running worker isn't holding overlay files open)
  // pass in the pre-deactivate activity state. Sampling pluginRegistry.list()
  // in here would otherwise always see the caller's own deactivate and treat
  // the plugin as never having been active. `??` is deliberate: a real
  // `false` override is honored as-is, only `undefined` falls through to
  // sampling the registry.
  async function hotSwapBuiltin(
    pluginId: string,
    knownWasActive?: boolean
  ): Promise<boolean> {
    const wasActive =
      knownWasActive ?? pluginRegistry.get(pluginId)?.state.status === 'active'
    await pluginHost.deactivate(pluginId).catch(() => {})
    await pluginRegistry.discover()
    if (!wasActive) return false
    try {
      await pluginHost.activate(pluginId)
      return false
    } catch {
      return true // restartRequired
    }
  }

  function toSourceInput(p: InstallPluginPayload): SourceInput {
    switch (p.sourceType) {
      case 'github':
        return { type: 'github', spec: p.spec }
      case 'url':
        return { type: 'url', url: p.url }
      case 'local':
        return { type: 'local', absPath: p.absPath, fileHash: p.fileHash }
      case 'registry':
        return { type: 'registry', pluginId: p.pluginId }
    }
  }

  async function materializeMoext(p: FetchedInstallPayload): Promise<string> {
    const downloadDir = path.join(userDataDir, 'plugin-downloads')
    switch (p.sourceType) {
      case 'github': {
        const spec = parseGithubSpec(p.spec)
        const target = path.join(
          downloadDir,
          `${spec.owner}-${spec.repo}-${Date.now()}.moext`
        )
        await downloadGithubMoext(spec, target)
        return target
      }
      case 'url': {
        const target = path.join(downloadDir, `download-${Date.now()}.moext`)
        await downloadUrlMoext(p.url, target)
        return target
      }
      case 'local':
        return p.absPath
    }
  }

  /**
   * Create a task, then await a debounced session save so that
   * - the IPC return implies durability (a crash *after* form submit
   *   commits won't lose the task's identity row in motrix.db),
   * - bursty bulk creates (e.g. paste 100 URLs) collapse into a
   *   single SQLite transaction via requestSave coalescing,
   * - polling's `syncTaskFilesIfMissing` no longer races the 15s
   *   auto-save window — by the time the next poll tick fires, the
   *   parent task_metadata row exists and the FK constraint passes.
   */
  async function createAndPersist(
    request: Parameters<typeof handleCreateTask>[0]
  ): Promise<TaskCreateCommandResult> {
    let result: Awaited<ReturnType<typeof handleCreateTask>>
    try {
      result = await handleCreateTask(request, createDeps)
    } catch (error) {
      const conflict = taskCreateConflictResult(error)
      if (conflict) return conflict
      throw error
    }
    try {
      await sessionManager.requestSave()
    } catch (err) {
      log.warn({ err }, 'post-create session save failed')
    }
    return result
  }

  // Plan C: plugins with `onTaskType:*` / `onProtocol:*` activation events
  // are *not* activated at startup (the only dispatch fired there is
  // `{kind:'startup'}`). They MUST be activated just-in-time when a task
  // arrives — otherwise their beforeCreate hooks never see the request.
  // Resolver plugins rely on this.
  async function activatePluginsForTask(
    taskType: 'http' | 'bt' | 'magnet',
    url: string
  ): Promise<void> {
    try {
      await pluginActivation.dispatch({ kind: 'taskAdded', taskType, url })
    } catch (err) {
      log.warn(
        { err, taskType, url },
        'plugin taskAdded dispatch failed; continuing'
      )
    }
  }

  // NAT handlers — rate-limited via TokenBucket
  const natHandlers = new NatCommandHandlers(natManager, {
    dialogConfirm: async (opts) => {
      const res = await dialog.showMessageBox({
        type: 'warning',
        title: opts.title,
        message: opts.message,
        detail: opts.detail,
        buttons: ['Cancel', 'Enable'],
        defaultId: 0,
        cancelId: 0,
      })
      return res.response === 1
    },
  })
  const saveDirPickersInFlight = new WeakSet<WebContents>()

  return {
    [Commands.InstallCliTool]: async (payload: unknown) =>
      cliToolService.install(
        cliInstallRequestSchema.parse(payload) as CliInstallRequest
      ),

    [Commands.ParseTorrent]: async ({ base64 }: { base64: string }) => {
      return torrentParser.parse(base64)
    },

    [Commands.AddTorrentTask]: async (params: {
      base64: string
      selectedFiles: number[]
      saveDir: string
    }) => {
      await activatePluginsForTask('bt', '')
      return createAndPersist({
        type: 'bt',
        payload: { kind: 'torrent-base64', base64: params.base64 },
        selectedFiles: params.selectedFiles,
        saveDir: params.saveDir || settingsManager.getApp().defaultSaveDir,
      })
    },

    [Commands.AddMagnetTask]: async (params: {
      uri: string
      selectedFiles: number[]
      saveDir: string
    }) => {
      await activatePluginsForTask('magnet', params.uri)
      return createAndPersist({
        type: 'bt',
        payload: { kind: 'magnet', uri: params.uri },
        selectedFiles: params.selectedFiles,
        saveDir: params.saveDir || settingsManager.getApp().defaultSaveDir,
      })
    },

    [Commands.HandleDroppedTorrent]: async ({
      base64,
      name,
    }: {
      base64: string
      name: string
    }) => {
      const meta = await torrentParser.parse(base64)
      sendToAddTaskWindow(windowManager, Events.ProtocolTorrentFile, {
        payload: { name, dataBase64: base64 },
        meta,
      })
      return { ok: true }
    },

    [Commands.PauseTask]: async (taskId: string) => {
      await pauseTask(taskId, pauseResumeDeps)
      return { ok: true }
    },

    [Commands.ResumeTask]: async (taskId: string) => {
      await resumeTask(taskId, pauseResumeDeps)
      return { ok: true }
    },

    // Plural task commands (option C): one IPC request per multi-select
    // action. Per-task outcomes come back IPC-safe; the bulk close inside
    // runBulkTaskAction forces one immediate snapshot flush.
    [Commands.PauseTasks]: async (rawPayload: unknown) => {
      const taskIds = taskIdsPayloadSchema.parse(rawPayload)
      return toBulkTaskCommandResult(
        await runBulkTaskAction(taskIds, pauseResumeDeps, pauseTask)
      )
    },

    [Commands.ResumeTasks]: async (rawPayload: unknown) => {
      const taskIds = taskIdsPayloadSchema.parse(rawPayload)
      return toBulkTaskCommandResult(
        await runBulkTaskAction(taskIds, pauseResumeDeps, resumeTask)
      )
    },

    [Commands.StopSeedingTasks]: async (rawPayload: unknown) => {
      const taskIds = taskIdsPayloadSchema.parse(rawPayload)
      return toBulkTaskCommandResult(
        await runBulkTaskAction(taskIds, stopSeedingDeps, (id) =>
          stopSeedingTask(id, stopSeedingDeps)
        )
      )
    },

    [Commands.ReAddTasks]: async (rawPayload: unknown) => {
      const taskIds = taskIdsPayloadSchema.parse(rawPayload)
      return toBulkTaskCommandResult(
        await runBulkTaskAction(taskIds, reAddDeps, (id) =>
          reAddTask(id, reAddDeps)
        )
      )
    },

    [Commands.RetryTasks]: async (rawPayload: unknown) => {
      const taskIds = taskIdsPayloadSchema.parse(rawPayload)
      return toBulkTaskCommandResult(
        await runBulkTaskAction(taskIds, reAddDeps, async (id) => {
          const task = taskManager.getById(id)
          if (task && canRetryMagnetMetadata(task)) {
            await magnetTracker.retryMetadata(id)
            return
          }
          await reAddTask(id, reAddDeps)
        })
      )
    },

    [Commands.RemoveTasks]: async (rawPayload: unknown) => {
      const { taskIds, deleteWithFiles } =
        removeTasksPayloadSchema.parse(rawPayload)
      return toBulkTaskCommandResult(
        await runBulkTaskAction(taskIds, removeDeps, (id) =>
          removeTask(id, { deleteWithFiles }, removeDeps)
        )
      )
    },

    [Commands.RemoveTask]: async (rawPayload: unknown) => {
      const { taskId, deleteWithFiles } =
        removeTaskPayloadSchema.parse(rawPayload)
      await removeTask(taskId, { deleteWithFiles }, removeDeps)
      return { ok: true }
    },

    [Commands.StopSeedingTask]: async (taskId: string) => {
      await stopSeedingTask(taskId, stopSeedingDeps)
      return { ok: true }
    },

    [Commands.ReAddTask]: async (taskId: string) => {
      await reAddTask(taskId, reAddDeps)
      return { ok: true }
    },

    [Commands.SetSelectedFiles]: createSetSelectedFilesHandler({
      taskManager,
      engine: adapter,
      db: motrixDatabase,
      eventBus,
      runTaskMutation,
    }),

    [Commands.ReopenMagnetFileSelection]: async (taskId: string) => {
      await magnetTracker.reopenFileSelection(taskId)
      return { ok: true }
    },

    [Commands.CreateTask]: async (request: unknown) => {
      // Schema validation happens inside handleCreateTask; createAndPersist
      // forwards the raw request unchanged. Activate plugins JIT first so
      // beforeCreate hooks see the request (Plan C: onTaskType/onProtocol
      // resolvers don't activate at startup).
      const parsed = taskCreateRequestSchema.safeParse(request)
      if (parsed.success) {
        const req = parsed.data
        if (req.type === 'http') {
          await activatePluginsForTask('http', req.uris[0] ?? '')
        } else if (req.payload.kind === 'magnet') {
          await activatePluginsForTask('magnet', req.payload.uri)
          if (
            req.selectedFiles.length === 0 &&
            settingsManager.getApp().magnetFileSelection
          ) {
            let taskId: string
            try {
              taskId = await magnetTracker.submit(
                req.payload.uri,
                req.saveDir || settingsManager.getApp().defaultSaveDir
              )
            } catch (error) {
              const conflict = taskCreateConflictResult(error)
              if (conflict) return conflict
              throw error
            }
            if (!taskId) return { ok: true }
            const existing = taskManager.getById(taskId)
            if (
              existing?.status === TaskStatus.Completed ||
              existing?.status === TaskStatus.Error
            ) {
              await reAddTask(taskId, reAddDeps)
              const owner = taskManager.getById(taskId) ?? existing
              return {
                outcome: 'rechecked',
                gid: owner.engineTaskId,
                taskId,
              }
            }
            return {
              outcome:
                existing?.status === TaskStatus.FetchingMetadata
                  ? 'created'
                  : 'reused',
              gid: existing?.engineTaskId ?? '',
              taskId,
            }
          }
        } else {
          await activatePluginsForTask('bt', '')
          // Plan B Task 3: user confirmed file selection for a magnet
          // whose metadata resolved while a `magnet_metadata_resolution`
          // task already exists in DB. Swap the instance in place so
          // the task identity, name, and Downloads list position
          // survive — instead of creating a duplicate task.
          if (req.payload.kind === 'torrent-base64' && req.existingTaskId) {
            const layout = await parseBtFileLayout(
              Buffer.from(req.payload.base64, 'base64')
            ).catch(() => null)
            const releaseAdmission = layout
              ? await acquireBtInfoHashAdmission(layout.infoHash)
              : null
            try {
              const admission = layout
                ? inspectBtDuplicate(taskManager.getAll(), {
                    infoHash: layout.infoHash,
                    saveDir: req.saveDir,
                    selectedFiles: req.selectedFiles,
                    duplicatePolicy: req.duplicatePolicy,
                    excludeTaskId: req.existingTaskId,
                  })
                : { action: 'create' as const }
              if (admission.action === 'conflict') {
                return { outcome: 'conflict', conflict: admission.conflict }
              }
              if (admission.action === 'reuse') {
                await removeTask(
                  req.existingTaskId,
                  { deleteWithFiles: false },
                  removeDeps
                )
                if (admission.recheck) {
                  await reAddTask(admission.task.id, reAddDeps)
                }
                const owner =
                  taskManager.getById(admission.task.id) ?? admission.task
                return {
                  outcome: admission.recheck ? 'rechecked' : 'reused',
                  gid: owner.engineTaskId,
                  taskId: owner.id,
                }
              }
              try {
                return await swapMagnetMetadataForBt(
                  {
                    taskId: req.existingTaskId,
                    base64: req.payload.base64,
                    selectedFiles: req.selectedFiles,
                    saveDir: req.saveDir,
                    name: req.displayName,
                    duplicatePolicy: req.duplicatePolicy,
                  },
                  {
                    db: motrixDatabase,
                    taskManager,
                    adapter,
                    magnetTracker,
                    finalNamePicker,
                    torrentMetaStore,
                    publishTaskUpdate,
                    publishTaskUpdateNow,
                    recordTransition,
                    runTaskMutation,
                    runExclusivePersistence: (operation) =>
                      sessionManager.runExclusivePersistence(operation),
                  }
                )
              } catch (error) {
                const conflict = taskCreateConflictResult(error)
                if (conflict) return conflict
                throw error
              }
            } finally {
              releaseAdmission?.()
            }
          }
        }
      }
      return createAndPersist(request as Parameters<typeof handleCreateTask>[0])
    },

    [Commands.UpdateSettings]: async (partial: unknown) => {
      const oldFull = settingsManager.get()

      // Apply privacy gate on the incoming partial before merging.
      const simulated = mergePartialForGate(oldFull, partial)
      const gated = await applyNatPrivacyGate({
        oldSettings: oldFull,
        newSettings: simulated,
        dialogConfirm: async (opts) => {
          const r = await dialog.showMessageBox({
            type: 'warning',
            title: opts.title,
            message: opts.message,
            detail: opts.detail,
            buttons: ['Cancel', 'Enable'],
            defaultId: 0,
            cancelId: 0,
          })
          return r.response === 1
        },
      })

      // Build a patched partial that reflects the user's dialog choice.
      const partialObj = partial as Record<string, unknown> | null | undefined
      const proxySubmitted =
        typeof partialObj === 'object' &&
        partialObj !== null &&
        Object.hasOwn(partialObj, 'proxy')
      const appPartial = partialObj?.app as
        | { protocols?: { magnet?: unknown } }
        | undefined
      const magnetPreferenceSubmitted =
        typeof appPartial?.protocols?.magnet === 'boolean'
      const patched = {
        ...partialObj,
        nat: {
          ...((partialObj?.nat as object | undefined) ?? {}),
          natTypeDetectionEnabled: gated.nat.natTypeDetectionEnabled,
          portReachabilityCheckEnabled: gated.nat.portReachabilityCheckEnabled,
        },
      }

      const result = await settingsManager.update(patched)
      const newFull = settingsManager.get()

      const proxySettingsChanged = proxyChanged(oldFull.proxy, newFull.proxy)
      if (
        proxySettingsChanged ||
        proxySubmitted ||
        appliedDownloadProxyPolicy.snapshot() === null
      ) {
        await appliedDownloadProxyPolicy.applyTransition(() => {
          const latestProxy = settingsManager.get().proxy
          // A command-local old value cannot describe concurrent updates
          // across independent scopes. Stale commands do no work; the one
          // matching the latest persisted value idempotently reasserts all
          // proxy consumers, including aria2's explicit direct route.
          return proxyChanged(newFull.proxy, latestProxy)
            ? Promise.resolve({ downloadProxy: 'unchanged' } as const)
            : proxyApplier.applyAll(latestProxy)
        })
      }

      // Proxy state is security-sensitive and settings are already durable at
      // this point. Apply/fail-closed before unrelated shell side effects can
      // reject and otherwise leave aria2 on the previous non-null route.
      let protocolAssociationApplied: boolean | undefined

      if (oldFull.app.updateChannel !== newFull.app.updateChannel) {
        updateManager.setChannel(newFull.app.updateChannel)
      }

      if (oldFull.app.launchAtStartup !== newFull.app.launchAtStartup) {
        syncAutoLaunch(newFull.app.launchAtStartup)
      }
      if (
        oldFull.app.browserBridgeEnabled !== newFull.app.browserBridgeEnabled
      ) {
        await bridgeManager.setEnabled(newFull.app.browserBridgeEnabled)
      }
      if (oldFull.bridge.fixedPort !== newFull.bridge.fixedPort) {
        await bridgeManager.restart()
      }
      if (
        magnetPreferenceSubmitted ||
        oldFull.app.protocols.magnet !== newFull.app.protocols.magnet
      ) {
        const registration = protocolManager.register()
        if (registration?.magnetMatchesSetting !== null) {
          protocolAssociationApplied = registration?.magnetMatchesSetting
        }
        const appImageView = await reconcileAppImageIntegrationFromSettings({
          getMagnetEnabled: () => newFull.app.protocols.magnet,
        })
        if (
          appImageView.supported &&
          appImageView.decision === 'accepted' &&
          appImageView.owner === 'self'
        ) {
          protocolAssociationApplied = appImageView.status === 'healthy'
        }
      }

      if (oldFull.app.defaultSaveDir !== newFull.app.defaultSaveDir) {
        await supervisor.applyDefaultSaveDir(newFull.app.defaultSaveDir)
      }

      if (oldFull.tracker.sourcesEnabled !== newFull.tracker.sourcesEnabled) {
        await trackerManager.applySourcesChange(newFull.tracker.sourcesEnabled)
      }

      if (
        oldFull.tracker.blacklistEnabled !== newFull.tracker.blacklistEnabled
      ) {
        await trackerManager.applyBlacklistChange(
          newFull.tracker.blacklistEnabled
        )
      }

      if (
        oldFull.tracker.autoSync !== newFull.tracker.autoSync ||
        oldFull.tracker.syncIntervalHours !== newFull.tracker.syncIntervalHours
      ) {
        trackerManager.applySyncScheduleChange()
      }

      await supervisor.applyEngineSettings(oldFull.engine, newFull.engine)

      if (oldFull.engine.dnsMode !== newFull.engine.dnsMode) {
        await supervisor.applyAsyncDns(
          dnsModeToAsyncDns(newFull.engine.dnsMode)
        )
        // Mode changes re-arm the auto fallback so a later switch back to
        // 'auto' starts optimistic again.
        dnsFallback?.reset()
      }

      if (result.requiresRestart) {
        publishEngineRestartRequired(
          { eventBus, notificationCenter, log },
          result.changedRestartKeys
        )
      }

      return protocolAssociationApplied === undefined
        ? result
        : { ...result, protocolAssociationApplied }
    },

    [Commands.RestartEngine]: async () => {
      await supervisor.restart()
      return { ok: true }
    },

    [Commands.RecoverEngine]: async (payload: unknown) => {
      return supervisor.recover(engineRecoverySchema.parse(payload))
    },

    [Commands.ConfirmPortSwitch]: async (newPort: number) => {
      await settingsManager.update({ engine: { rpcPort: newPort } })
      return { ok: true }
    },

    [Commands.NextTorrent]: async () => {
      const advanced = await protocolManager.nextTorrent()
      return { advanced }
    },

    [Commands.DownloadAllTorrents]: async (rawOptions: unknown) => {
      const options = torrentBatchCreateOptionsSchema.parse(rawOptions)
      const torrents = await protocolManager.downloadAllTorrents()
      let succeeded = 0
      let failed = 0
      let firstTaskId: string | null = null

      for (const [index, torrent] of torrents.entries()) {
        try {
          await activatePluginsForTask('bt', '')
          const result = await createAndPersist({
            type: 'bt',
            payload: {
              kind: 'torrent-base64',
              base64: torrent.payload.dataBase64,
            },
            selectedFiles:
              index === 0
                ? options.selectedFiles
                : torrent.meta.files.map((file) => file.index),
            saveDir: options.saveDir,
            dlLimit: options.dlLimit,
            ulLimit: options.ulLimit,
            seedRatio: options.seedRatio,
            displayName: torrent.meta.name,
          })
          if (result.outcome === 'conflict') {
            failed += 1
            continue
          }
          succeeded += 1
          firstTaskId ??= result.taskId
        } catch (err) {
          failed += 1
          log.warn(
            { err, torrent: torrent.payload.name },
            'batch torrent creation failed'
          )
        }
      }

      return {
        total: torrents.length,
        succeeded,
        failed,
        firstTaskId,
      }
    },

    // CloseCurrentWindow needs event.sender — the wrapper in registerCommandHandlers
    // passes sender as the first arg so this handler can resolve the window id.
    [Commands.CloseCurrentWindow]: async (
      sender: WebContents,
      rawOptions?: unknown
    ) => {
      const options = closeCurrentWindowSchema.parse(rawOptions ?? {})
      const id = windowManager.getWindowIdBySender(sender)
      if (id) {
        if (id === 'add-task') {
          protocolManager.resetDialogState()
        }
        windowManager.closeAndRecycle(id)
        if (options.showMain) {
          windowManager.show('main')
        }
        if (options.navigateMainTo) {
          // Events.NavigateTo is forwarded to the main window only — see
          // src/main/ipc/events.ts. Emitting after closeAndRecycle/show
          // lets the closing child window atomically hand off the route
          // to the main React Router tree.
          eventBus.emit(Events.NavigateTo, options.navigateMainTo)
        }
      }
      return { ok: true }
    },

    // Operate only on the trusted window that originated each custom caption
    // control request. No renderer can target a different BrowserWindow.
    [Commands.MinimizeCurrentWindow]: async (sender: WebContents) => {
      const win = BrowserWindow.fromWebContents(sender)
      if (win && !win.isDestroyed() && win.isMinimizable()) {
        win.minimize()
      }
      return { ok: true }
    },

    [Commands.ToggleMaximizeCurrentWindow]: async (sender: WebContents) => {
      const win = BrowserWindow.fromWebContents(sender)
      if (win && !win.isDestroyed() && win.isMaximizable()) {
        if (win.isMaximized()) {
          win.unmaximize()
        } else {
          win.maximize()
        }
      }
      return { ok: true }
    },

    [Commands.PickSaveDir]: async (
      sender: WebContents,
      params: { defaultPath?: string }
    ) => {
      if (saveDirPickersInFlight.has(sender)) return null

      saveDirPickersInFlight.add(sender)
      try {
        const options: OpenDialogOptions = {
          properties: ['openDirectory'],
          defaultPath: params.defaultPath,
        }
        const parent = BrowserWindow.fromWebContents(sender)
        const result =
          parent && !parent.isDestroyed()
            ? await dialog.showOpenDialog(parent, options)
            : await dialog.showOpenDialog(options)
        if (result.canceled || result.filePaths.length === 0) {
          return null
        }
        return { path: result.filePaths[0] }
      } finally {
        saveDirPickersInFlight.delete(sender)
      }
    },

    // ResizeWindow needs event.sender — the wrapper in registerCommandHandlers
    // passes sender as the first arg so this handler can resolve the BrowserWindow.
    [Commands.ResizeWindow]: async (
      sender: WebContents,
      params: { width: number; height: number }
    ) => {
      const win = BrowserWindow.fromWebContents(sender)
      if (win && !win.isDestroyed()) {
        const [currentWidth, currentHeight] = win.getSize()
        if (currentWidth !== params.width || currentHeight !== params.height) {
          // Electron #42258: setSize cannot shrink non-resizable windows on
          // Windows and Linux. Partial bounds preserve the window position.
          win.setBounds({ width: params.width, height: params.height }, true)
        }
      }
      return { ok: true }
    },

    [Commands.ShowMainWindow]: async () => {
      windowManager.show('main')
      return { ok: true }
    },

    [Commands.ShowAddTaskWindow]: async (rawPayload: unknown) => {
      const { prefill } = showAddTaskWindowSchema.parse(rawPayload ?? {})
      const win = windowManager.open('add-task')
      const showPayload = prefill ?? { mode: 'links' }
      const sendShow = () => {
        if (!win.isDestroyed()) {
          win.webContents.send(Events.SetAddTaskMode, showPayload)
        }
      }
      if (win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', sendShow)
      } else {
        sendShow()
      }
      return { ok: true }
    },

    [Commands.OpenExternal]: async (url: string) => {
      if (/^(https?|mailto):/i.test(url)) {
        await shell.openExternal(url)
      }
      return { ok: true }
    },

    [Commands.EnableAppImageIntegration]: async () =>
      enableAppImageIntegrationFromSettings({
        getMagnetEnabled: () => settingsManager.getApp().protocols.magnet,
      }),

    [Commands.RemoveAppImageIntegration]: async () =>
      removeAppImageIntegrationFromSettings({
        getMagnetEnabled: () => settingsManager.getApp().protocols.magnet,
      }),

    [Commands.RequestDefaultTorrentHandler]: async () => {
      if (process.platform === 'darwin') {
        // macOS has no central default-apps panel. The previous implementation
        // opened the General preference pane, which is unrelated to file
        // associations. Pending evaluation of native LSSetDefaultRoleHandler
        // bindings; for now we keep the (suboptimal) jump so the button does
        // something rather than nothing.
        await shell.openExternal(
          'x-apple.systempreferences:com.apple.preference.general'
        )
        return { ok: true, action: 'opened-settings' as const }
      }
      if (process.platform === 'win32') {
        try {
          await shell.openExternal(await resolveWindowsDefaultAppsSettingsUrl())
          return { ok: true, action: 'opened-settings' as const }
        } catch {
          await shell.openExternal(
            EXTERNAL_URLS.motrix.manual.defaultApplication
          )
          return { ok: true, action: 'opened-fallback' as const }
        }
      }
      try {
        await setLinuxDefaultTorrentHandler()
        return { ok: true, action: 'set' as const }
      } catch {
        await shell.openExternal(EXTERNAL_URLS.motrix.manual.defaultApplication)
        return { ok: true, action: 'opened-fallback' as const }
      }
    },

    [Commands.RevealInFolder]: createRevealInFolderHandler({
      shell,
      getTask: (taskId) => taskManager.getById(taskId),
    }),

    [Commands.EnableNat]: async () => natHandlers.enable(),
    [Commands.DisableNat]: async () => natHandlers.disable(),
    [Commands.ForceRemapNat]: async () => natHandlers.forceRemap(),
    [Commands.RunNatDiagnostic]: async () => natHandlers.runDiagnostic(),
    [Commands.ExportNatBundle]: async () => natHandlers.exportBundle(),

    [Commands.CheckForUpdates]: async () => {
      await updateManager.check()
      return { ok: true }
    },

    [Commands.DownloadUpdate]: async () => {
      await updateManager.download()
      return { ok: true }
    },

    [Commands.InstallUpdate]: async () => {
      updateManager.install()
      return { ok: true }
    },

    [Commands.SyncTrackers]: async () => {
      log.info('syncTrackers: invoked')
      try {
        const result = await trackerManager.syncAndCurate()
        log.info(
          {
            totalFetched: result.totalFetched,
            totalHealthy: result.totalHealthy,
            totalCurated: result.totalCurated,
          },
          'syncTrackers: ok'
        )
        return result
      } catch (err) {
        log.error({ err }, 'syncTrackers: failed')
        throw err
      }
    },

    [Commands.SetTaskBtTracker]: async (params: {
      engineGid: string
      trackers: string[]
    }) => {
      const task = taskManager.getByEngineTaskId(params.engineGid)
      if (!task) return
      await trackerManager.setBtTracker(
        task.id,
        params.engineGid,
        params.trackers
      )
    },

    [Commands.SyncTaskBtTracker]: async (params: { engineGid: string }) => {
      const task = taskManager.getByEngineTaskId(params.engineGid)
      if (!task) return
      const pair = motrixDatabase.getTask(task.id)
      const isPrivate = pair?.task.isPrivate ?? false
      await trackerManager.syncBtTracker(task.id, params.engineGid, isPrivate)
    },

    [Commands.UpdateMenuContext]: async (sender: WebContents, raw: unknown) => {
      if (windowManager.getWindowIdBySender(sender) !== 'main') {
        throw new Error('Blocked menu-context update from a non-main window')
      }
      const patch = MenuContextPatchSchema.parse(raw)
      contextStore.merge(patch)
      return { ok: true }
    },

    [Commands.UpdateGeoIPDatabase]: createUpdateGeoIPDatabaseHandler({
      geoipManager,
    }),

    [Commands.EnablePlugin]: async (id: string) => {
      pluginStateStore.setEnabled(id, true)
      // Sync the in-memory IndexedPlugin.state so Queries.ListPlugins and
      // downstream gating (PluginHost.activate, ActivationDispatcher,
      // CrossPluginInvoker) see the new enabled flag without a process
      // restart.
      pluginRegistry.refreshState(id)
      const state = pluginStateStore.get(id)
      eventBus.emit(Events.PluginStatusChanged, {
        id,
        status: state?.status ?? 'inactive',
        enabled: true,
      })
      eventBus.emit(Events.ContributionIndexChanged)
      return { ok: true }
    },

    [Commands.DisablePlugin]: async (id: string) => {
      await pluginHost.deactivate(id)
      pluginStateStore.setEnabled(id, false)
      pluginRegistry.refreshState(id)
      const state = pluginStateStore.get(id)
      eventBus.emit(Events.PluginStatusChanged, {
        id,
        status: state?.status ?? 'disabled',
        enabled: false,
      })
      eventBus.emit(Events.ContributionIndexChanged)
      return { ok: true }
    },

    [Commands.UpdatePluginConfig]: async (payload: unknown) => {
      const parsed = updatePluginConfigSchema.parse(payload)
      const indexed = pluginRegistry.get(parsed.pluginId)
      if (!indexed) {
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          `unknown plugin: ${parsed.pluginId}`
        )
      }

      // Walk schema to collect secret-flagged field names.
      const schema = indexed.manifest.contributes?.configuration?.schema
      const properties =
        schema &&
        typeof schema === 'object' &&
        'properties' in schema &&
        schema.properties &&
        typeof schema.properties === 'object'
          ? (schema.properties as Record<string, unknown>)
          : {}
      const secretFields = new Set<string>()
      for (const [key, prop] of Object.entries(properties)) {
        if (
          prop &&
          typeof prop === 'object' &&
          (prop as { secret?: boolean }).secret === true
        ) {
          secretFields.add(key)
        }
      }

      // Build effective patch with secrets encrypted.
      const prior = settingsManager.get().plugins[parsed.pluginId] ?? {}
      const effective: Record<string, unknown> = {}
      const changes: Array<{ key: string; value: unknown; previous: unknown }> =
        []
      for (const [key, value] of Object.entries(parsed.patch)) {
        let stored: unknown = value
        if (secretFields.has(key) && typeof value === 'string') {
          if (!capabilityHost.secrets.available()) {
            throw new AppError(
              ErrorCode.PluginRuntimeFault,
              'secret store unavailable; cannot persist secret field'
            )
          }
          stored = await capabilityHost.secrets.encrypt(value)
        }
        effective[key] = stored
        changes.push({ key, value: stored, previous: prior[key] })
      }

      const nextConfig = { ...prior, ...effective }
      // Spec §7 L2319-2333 — appSettings.plugins[id] carries `config` ONLY.
      // Never write `enabled` here; that field lives exclusively in
      // plugin_state (managed by PluginStateStore). Co-locating them would
      // race with the circuit breaker and the user-driven enable/disable
      // toggle.
      await settingsManager.update({
        plugins: { [parsed.pluginId]: nextConfig },
      })

      // Emit + fire in-VM listeners.
      eventBus.emit(Events.PluginConfigChanged, {
        pluginId: parsed.pluginId,
        changes,
      })
      capabilityHost.configFor(parsed.pluginId).applyExternalChange(changes)

      return { ok: true }
    },

    [Commands.InstallPlugin]: async (payload: unknown) => {
      const parsed = installPluginPayloadSchema.parse(payload)
      let moextPath: string
      let expect: RegistryExpectation | undefined
      if (parsed.sourceType === 'registry') {
        const entry = await registryClient.get(parsed.pluginId, hostVersion)
        if (!entry) {
          throw new AppError(
            ErrorCode.PluginManifestInvalid,
            'plugin.install.registry_entry_missing'
          )
        }
        // The UI disables the button; main still enforces the gate
        // (viewable-but-not-installable is a contract, not a style).
        if (!entry.compatible) {
          throw new AppError(
            ErrorCode.PluginManifestInvalid,
            'plugin.install.registry_incompatible'
          )
        }
        moextPath = path.join(
          userDataDir,
          'plugin-downloads',
          `registry-${parsed.pluginId}-${Date.now()}.moext`
        )
        await downloadRegistryMoext(entry, moextPath)
        expect = buildRegistryExpectation(entry)
      } else {
        moextPath = await materializeMoext(parsed)
      }
      const result = await pluginInstaller.stage(
        moextPath,
        toSourceInput(parsed),
        { expect, runtimeHost: pluginHost }
      )
      if (result.committed && result.pluginId) {
        eventBus.emit(Events.PluginInstalled, { pluginId: result.pluginId })
      } else {
        eventBus.emit(Events.PluginInstallConsentRequested, {
          stagingId: result.stagingId,
          consent: result.consent,
        })
      }
      return result
    },

    [Commands.CheckPluginUpdates]: async (payload: unknown) => {
      const parsed = checkPluginUpdatesPayloadSchema.parse(payload)
      if (parsed?.force) await registryClient.refresh()
      const entries = await registryClient.list(hostVersion)
      return scanForUpdates(pluginRegistry.list(), entries)
    },

    [Commands.InstallBuiltinUpdate]: async (payload: unknown) => {
      const parsed = builtinUpdatePayloadSchema.parse(payload)
      const entry = await registryClient.get(parsed.pluginId, hostVersion)
      if (entry?.origin !== 'builtin') {
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          'plugin.update.builtin_entry_missing'
        )
      }
      const effective = pluginRegistry.get(parsed.pluginId)?.manifest
      if (!effective) {
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          'plugin.update.builtin_entry_missing'
        )
      }
      const staged = await builtinUpdater.stage(entry, effective)
      if (staged.trustChanged) {
        return { needsConsent: true, ...staged }
      }
      await builtinUpdater.commit(staged.stagingId)
      const restartRequired = await hotSwapBuiltin(parsed.pluginId)
      // Same event ConfirmPluginInstall emits after a community install
      // commits: usePlugins.onLifecycle refetches ListPlugins so the
      // plugin's version/status/source.type (builtin -> builtin-update)
      // update live, without a remount. Only on the committed path — a
      // needsConsent return above has not touched disk yet.
      eventBus.emit(Events.PluginInstalled, { pluginId: parsed.pluginId })
      return { ok: true, restartRequired }
    },

    [Commands.ConfirmBuiltinUpdate]: async (payload: unknown) => {
      const parsed = builtinStagingPayloadSchema.parse(payload)
      const { pluginId } = await builtinUpdater.commit(parsed.stagingId)
      const restartRequired = await hotSwapBuiltin(pluginId)
      eventBus.emit(Events.PluginInstalled, { pluginId })
      return { ok: true, restartRequired }
    },

    [Commands.CancelBuiltinUpdate]: async (payload: unknown) => {
      const parsed = builtinStagingPayloadSchema.parse(payload)
      await builtinUpdater.cancel(parsed.stagingId)
      return { ok: true }
    },

    [Commands.RevertBuiltinToBundled]: async (payload: unknown) => {
      const parsed = builtinUpdatePayloadSchema.parse(payload)
      // Sample activity BEFORE deactivating — hotSwapBuiltin's own sampling
      // would otherwise always see this handler's deactivate and think the
      // plugin was never active, so revert never reactivates it.
      const wasActive =
        pluginRegistry.list().find((p) => p.id === parsed.pluginId)?.status ===
        'active'
      await pluginHost.deactivate(parsed.pluginId).catch(() => {})
      await rm(path.join(overlayDir, parsed.pluginId), {
        recursive: true,
        force: true,
      })
      const restartRequired = await hotSwapBuiltin(parsed.pluginId, wasActive)
      eventBus.emit(Events.PluginInstalled, { pluginId: parsed.pluginId })
      return { ok: true, restartRequired }
    },

    [Commands.ConfirmPluginInstall]: async (payload: unknown) => {
      const parsed = confirmPluginInstallPayloadSchema.parse(payload)
      const { pluginId } = await pluginInstaller.commit(
        parsed.stagingId,
        parsed.grants,
        pluginHost
      )
      eventBus.emit(Events.PluginInstalled, { pluginId })
      return { ok: true, pluginId }
    },

    [Commands.CancelPluginInstall]: async (payload: unknown) => {
      const parsed = z.object({ stagingId: z.string().min(1) }).parse(payload)
      await pluginInstaller.cancel(parsed.stagingId)
      return { ok: true }
    },

    [Commands.UpdatePluginGrants]: async (payload: unknown) => {
      const parsed = z
        .object({
          pluginId: z.string().min(1),
          patch: z.record(z.string(), z.enum(['granted', 'denied'])),
        })
        .parse(payload)
      const grants = await pluginGrants.updateGrants(
        parsed.pluginId,
        parsed.patch
      )
      // GrantsManager emits internally; commands.ts does not double-emit.
      return { ok: true, grants }
    },

    [Commands.UninstallPlugin]: async (payload: unknown) => {
      const parsed = z.object({ pluginId: z.string().min(1) }).parse(payload)
      await pluginInstaller.uninstall(parsed.pluginId, pluginHost)
      await settingsManager.removePluginConfig(parsed.pluginId)
      eventBus.emit(Events.PluginUninstalled, { pluginId: parsed.pluginId })
      return { ok: true }
    },

    [Commands.ClearPluginLogs]: async (payload: unknown) => {
      const parsed = z.object({ pluginId: z.string().min(1) }).parse(payload)
      capabilityHost.clearLog(parsed.pluginId)
      return { ok: true }
    },

    [Commands.SetPluginLogVerbose]: async (payload: unknown) => {
      const parsed = z
        .object({ pluginId: z.string().min(1), verbose: z.boolean() })
        .parse(payload)
      capabilityHost.setLogVerbose(parsed.pluginId, parsed.verbose)
      return { ok: true }
    },
  }
}

export function registerCommandHandlers(ctx: CommandContext): () => void {
  const handlers = buildCommandHandlers(ctx)
  const channels = Object.keys(handlers)
  const invoke = (operation: () => unknown): Promise<unknown> =>
    ctx.trackAsyncWork
      ? ctx.trackAsyncWork(async () => operation())
      : Promise.resolve().then(operation)

  for (const [channel, handler] of Object.entries(handlers)) {
    // Window-bound commands need event.sender — pass it as the first arg.
    if (
      channel === Commands.CloseCurrentWindow ||
      channel === Commands.MinimizeCurrentWindow ||
      channel === Commands.ToggleMaximizeCurrentWindow ||
      channel === Commands.PickSaveDir ||
      channel === Commands.ResizeWindow ||
      channel === Commands.UpdateMenuContext
    ) {
      registerTrustedIpcHandler(channel, (event, ...args) =>
        invoke(() =>
          // biome-ignore lint/suspicious/noExplicitAny: sender forwarded explicitly
          (handler as any)(event.sender, ...args)
        )
      )
    } else {
      registerTrustedIpcHandler(channel, async (_event, ...args) =>
        invoke(() => handler(...args))
      )
    }
  }
  return () => {
    for (const channel of channels) {
      ipcMain.removeHandler(channel)
    }
  }
}

function proxyChanged(a: ProxySettings, b: ProxySettings): boolean {
  return JSON.stringify(a) !== JSON.stringify(b)
}

function mergePartialForGate<T>(base: T, partial: unknown): T {
  if (!partial || typeof partial !== 'object') return base
  const p = partial as Record<string, unknown>
  const merged = { ...base } as Record<string, unknown>
  if (p.nat && typeof p.nat === 'object') {
    merged.nat = {
      ...((base as Record<string, unknown>).nat as object),
      ...(p.nat as object),
    }
  }
  if (p.engine && typeof p.engine === 'object') {
    merged.engine = {
      ...((base as Record<string, unknown>).engine as object),
      ...(p.engine as object),
    }
  }
  if (p.app && typeof p.app === 'object') {
    merged.app = {
      ...((base as Record<string, unknown>).app as object),
      ...(p.app as object),
    }
  }
  return merged as T
}
