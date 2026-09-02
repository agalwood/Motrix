import path from 'node:path'
import type { Aria2RpcClient } from '@core/engine/aria2/aria2-rpc-client'
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
import { pluginSecretFields } from '@core/plugin/configuration-schema'
import type { GrantsManager } from '@core/plugin/grants/grants-manager'
import { HookAuditLog } from '@core/plugin/hooks/audit-log'
import { HookOrchestrator } from '@core/plugin/hooks/hook-orchestrator'
import type { ActivationDispatcher } from '@core/plugin/host/activation-dispatcher'
import type { PluginHost } from '@core/plugin/host/plugin-host'
import type { PluginInstaller } from '@core/plugin/install/plugin-installer'
import type { PluginRegistry } from '@core/plugin/plugin-registry'
import type { RegistryClient } from '@core/plugin/registry/registry-client'
import { scanForUpdates } from '@core/plugin/registry/update-scan'
import type { PluginStateStore } from '@core/plugin/state/plugin-state-store'
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
import { createSetSelectedFilesHandler } from '@core/task/set-selected-files'
import type { TaskManager } from '@core/task/task-manager'
import type { TorrentMetaStore } from '@core/task/torrent-meta-store'
import type { MagnetTracker } from '@core/torrent/magnet-tracker'
import { swapMagnetMetadataForBt } from '@core/torrent/swap-magnet-metadata-for-bt'
import type { TrackerManager } from '@core/tracker'
import { AppError, ErrorCode } from '@shared/errors'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import type { CommandHandlerMap } from '@shared/protocol/handler-types'
import { taskCreateRequestSchema } from '@shared/schemas/add-task'
import {
  removeTasksPayloadSchema,
  taskIdsPayloadSchema,
} from '@shared/schemas/bulk-task-command'
import { supportedLocaleSchema } from '@shared/schemas/locale'
import { checkPluginUpdatesPayloadSchema } from '@shared/schemas/plugin-update'
import { removeTaskPayloadSchema } from '@shared/schemas/remove-task'
import { EngineRecoveryAction } from '@shared/types/engine'
import type { ProxySettings } from '@shared/types/settings'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { canRetryMagnetMetadata } from '@shared/types/task-actions'
import type { TaskActivityRecorder } from '@shared/types/task-activity'
import type { TaskOccurrence } from '@shared/types/task-occurrence'
import { z } from 'zod'
import type { ServerDownloadPathPolicy } from '../download-path-policy'
import type { ServerPluginInstallService } from '../plugin/install-service'
import type { createServerProxyApplier } from '../proxy/wiring'

export interface ServerCommandContext {
  supervisor: EngineSupervisor
  settingsManager: SettingsManager
  geoipManager: Pick<GeoIPManager, 'triggerUpdate'>
  /** Session latch of the auto DNS fallback — reset when dnsMode changes. */
  dnsFallback?: Pick<DnsFallbackConsumer, 'reset'>
  /**
   * Late-binds the DNS fallback consumer's task retry to the same
   * `reAddTask` deps bundle the ReAddTasks command uses, so the two
   * paths cannot drift. Called synchronously during handler construction.
   */
  bindTaskRetry?: (fn: (taskId: string) => Promise<unknown>) => void
  rpcClient: Aria2RpcClient
  adapter: EngineAdapter
  trackerManager: TrackerManager
  bridgeControl?: {
    setEnabled(enabled: boolean): Promise<void>
    restart(): Promise<void>
  }
  aria2BinaryPath: string
  finalNamePicker: FinalNamePicker
  torrentMetaStore: TorrentMetaStore
  taskManager: TaskManager
  fileCleanupService: FileCleanupService
  eventBus: EventBus
  proxyApplier: ReturnType<typeof createServerProxyApplier>
  appliedDownloadProxyPolicy: AppliedDownloadProxyPolicy
  motrixDatabase: MotrixDatabase
  notificationCenter: NotificationCenter
  taskPersistence: Pick<SessionManager, 'runExclusivePersistence'>
  pluginRegistry: PluginRegistry
  registryClient: RegistryClient
  hostVersion: string
  pluginStateStore: PluginStateStore
  pluginHost: PluginHost
  pluginInstaller: PluginInstaller
  pluginInstallService: ServerPluginInstallService
  pluginGrants: GrantsManager
  capabilityHost: CapabilityHost
  userDataDir: string
  pluginsDir: string
  pluginActivation: ActivationDispatcher
  magnetTracker: MagnetTracker
  activityRecorder: TaskActivityRecorder
  persistTask?: NonNullable<TaskActionDeps['persistTask']>
  /**
   * Persist a task and (when non-null) its terminal occurrence in a single
   * durable transaction — used INSTEAD OF `persistTask` whenever a status
   * transition qualifies for one. Optional; absence degrades pauseTask/
   * resumeTask to plain `persistTask` (no occurrence emitted).
   */
  persistTaskWithOccurrence?: (
    task: DownloadTask,
    occurrence: TaskOccurrence | null
  ) => Promise<void>
  /** Delivers a just-committed terminal occurrence to in-process consumers. */
  occurrenceDispatcher?: Pick<OccurrenceDispatcher, 'dispatch'>
  recordTransition?: (input: TaskTransitionRecordInput) => void | Promise<void>
  deleteParentTasks?: NonNullable<TaskActionDeps['deleteParentTasks']>
  runTaskMutation: NonNullable<TaskActionDeps['runTaskMutation']>
  parentTaskCreated?: (
    task: DownloadTask,
    persistParent: () => void | Promise<void>
  ) => Promise<void>
  /** Coalesced / immediate TaskUpdated publication (TaskUpdatePublisher). */
  publishTaskUpdate: TaskActionDeps['publishTaskUpdate']
  publishTaskUpdateNow: TaskActionDeps['publishTaskUpdateNow']
  downloadPathPolicy: ServerDownloadPathPolicy
}

export function buildServerCommandHandlers(
  ctx: ServerCommandContext
): CommandHandlerMap {
  const {
    supervisor,
    settingsManager,
    geoipManager,
    dnsFallback,
    bindTaskRetry,
    adapter,
    trackerManager,
    bridgeControl,
    finalNamePicker,
    torrentMetaStore,
    taskManager,
    fileCleanupService,
    eventBus,
    proxyApplier,
    appliedDownloadProxyPolicy,
    motrixDatabase,
    notificationCenter,
    taskPersistence,
    pluginRegistry,
    registryClient,
    hostVersion,
    pluginStateStore,
    pluginHost,
    pluginInstaller,
    pluginInstallService,
    pluginGrants,
    capabilityHost,
    userDataDir,
    pluginsDir,
    pluginActivation,
    magnetTracker,
    activityRecorder,
    persistTask: injectedPersistTask,
    persistTaskWithOccurrence,
    occurrenceDispatcher,
    recordTransition,
    deleteParentTasks: injectedDeleteParentTasks,
    runTaskMutation,
    parentTaskCreated: injectedParentTaskCreated,
    publishTaskUpdate,
    publishTaskUpdateNow,
    downloadPathPolicy,
  } = ctx

  const persistTask =
    injectedPersistTask ?? (async (_task: DownloadTask) => undefined)
  const deleteParentTasks =
    injectedDeleteParentTasks ??
    (async (
      _taskIds: readonly string[],
      deleteParents: () => void | Promise<void>
    ) => {
      await deleteParents()
    })
  const parentTaskCreated =
    injectedParentTaskCreated ??
    (async (_task: DownloadTask, persistParent: () => void | Promise<void>) => {
      await persistParent()
    })

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
      taskPersistence.runExclusivePersistence(() =>
        deleteParentTasks([taskId], () => {
          motrixDatabase.deleteTask(taskId)
        })
      ),
    runTaskMutation,
    waitForEngineReady: () =>
      supervisor.waitUntilReady(ENGINE_READY_TIMEOUT_MS),
    assertEngineReady: () => supervisor.assertReady(),
    prepareSaveDir: (requested: string) =>
      downloadPathPolicy.prepareSaveDir(requested),
  }

  const log = getLogger('server:commands')

  // Shared by the singular AND plural task command handlers below — one
  // deps bundle per action family so the two arities cannot drift.
  const pauseResumeDeps = {
    taskManager,
    adapter,
    eventBus,
    log,
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
    taskPersistence,
    deleteParentTasks,
    runTaskMutation,
    publishTaskUpdate,
    publishTaskUpdateNow,
  }

  // Plan C: plugins with `onTaskType:*` / `onProtocol:*` activation events
  // are not activated at startup. Activate just-in-time when a task arrives
  // so their beforeCreate hooks can run for the request.
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

  const updatePluginConfigSchema = z.object({
    pluginId: z.string().min(1),
    patch: z.record(z.string(), z.unknown()),
  })
  const engineRecoverySchema = z.object({
    action: z.enum(EngineRecoveryAction),
    expectedPid: z.number().int().positive().optional(),
  })
  return {
    [Commands.SetDisclaimerLanguage]: async (payload: unknown) => {
      const language = supportedLocaleSchema.parse(payload)
      await settingsManager.setDisclaimerLanguage(language)
      return { ok: true }
    },

    [Commands.AcceptDisclaimer]: async () => {
      await settingsManager.acceptDisclaimer()
      return { ok: true }
    },

    [Commands.AddMagnetTask]: async (params: {
      uri: string
      selectedFiles: number[]
      saveDir: string
    }) => {
      await activatePluginsForTask('magnet', params.uri)
      return handleCreateTask(
        {
          type: 'bt',
          payload: { kind: 'magnet', uri: params.uri },
          selectedFiles: params.selectedFiles,
          saveDir: params.saveDir || settingsManager.getApp().defaultSaveDir,
        },
        createDeps
      )
    },

    [Commands.AddTorrentTask]: async (params: {
      base64: string
      selectedFiles: number[]
      saveDir: string
    }) => {
      await activatePluginsForTask('bt', '')
      return handleCreateTask(
        {
          type: 'bt',
          payload: { kind: 'torrent-base64', base64: params.base64 },
          selectedFiles: params.selectedFiles,
          saveDir: params.saveDir || settingsManager.getApp().defaultSaveDir,
        },
        createDeps
      )
    },

    [Commands.ReopenMagnetFileSelection]: async (taskId: string) => {
      await magnetTracker.reopenFileSelection(taskId)
      return { ok: true }
    },

    [Commands.CreateTask]: async (request: unknown) => {
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
            const saveDir = await downloadPathPolicy.prepareSaveDir(
              req.saveDir || settingsManager.getApp().defaultSaveDir
            )
            let taskId: string
            try {
              taskId = await magnetTracker.submit(req.payload.uri, saveDir)
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
          // whose metadata resolved. Swap the persisted
          // magnet_metadata_resolution instance for a fresh bt_download
          // instance in place so task identity / Downloads list slot
          // survive (no duplicate row appears).
          if (req.payload.kind === 'torrent-base64' && req.existingTaskId) {
            const saveDir = await downloadPathPolicy.prepareSaveDir(req.saveDir)
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
                    saveDir,
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
                    saveDir,
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
                      taskPersistence.runExclusivePersistence(operation),
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
      try {
        return await handleCreateTask(request, createDeps)
      } catch (error) {
        const conflict = taskCreateConflictResult(error)
        if (conflict) return conflict
        throw error
      }
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
    // action from the web renderer. Same handlers as desktop.
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

    [Commands.StopSeedingTask]: async (taskId: string) => {
      await stopSeedingTask(taskId, stopSeedingDeps)
      return { ok: true }
    },

    [Commands.ReAddTask]: async (taskId: string) => {
      await reAddTask(taskId, reAddDeps)
      return { ok: true }
    },

    [Commands.RemoveTask]: async (rawPayload: unknown) => {
      const { taskId, deleteWithFiles } =
        removeTaskPayloadSchema.parse(rawPayload)
      await removeTask(taskId, { deleteWithFiles }, removeDeps)
      return { ok: true }
    },

    [Commands.SetSelectedFiles]: createSetSelectedFilesHandler({
      taskManager,
      engine: adapter,
      db: motrixDatabase,
      eventBus,
      runTaskMutation,
    }),

    [Commands.RestartEngine]: async () => {
      await supervisor.restart()
      return { ok: true }
    },

    [Commands.RecoverEngine]: async (payload: unknown) => {
      return supervisor.recover(engineRecoverySchema.parse(payload))
    },

    [Commands.UpdateSettings]: async (partial: unknown) => {
      const saveDirPatch = z
        .object({
          app: z
            .object({ defaultSaveDir: z.string().optional() })
            .passthrough()
            .optional(),
        })
        .passthrough()
        .safeParse(partial)
      let validatedPartial = partial
      if (
        saveDirPatch.success &&
        saveDirPatch.data.app?.defaultSaveDir !== undefined
      ) {
        const defaultSaveDir = await downloadPathPolicy.prepareSaveDir(
          saveDirPatch.data.app.defaultSaveDir
        )
        validatedPartial = {
          ...saveDirPatch.data,
          app: { ...saveDirPatch.data.app, defaultSaveDir },
        }
      }
      const proxySubmitted =
        typeof validatedPartial === 'object' &&
        validatedPartial !== null &&
        Object.hasOwn(validatedPartial, 'proxy')
      const oldFull = settingsManager.get()
      const result = await settingsManager.update(
        validatedPartial as Parameters<typeof settingsManager.update>[0]
      )
      const newFull = settingsManager.get()

      const proxySettingsChanged = proxyChanged(oldFull.proxy, newFull.proxy)
      if (
        proxySettingsChanged ||
        proxySubmitted ||
        appliedDownloadProxyPolicy.snapshot() === null
      ) {
        await appliedDownloadProxyPolicy.applyTransition(() => {
          const latestProxy = settingsManager.get().proxy
          // Re-check after acquiring the writer, then reassert the entire
          // latest proxy state. Incremental command-local diffs lose updates
          // when concurrent commands modify different proxy scopes.
          return proxyChanged(newFull.proxy, latestProxy)
            ? Promise.resolve({ downloadProxy: 'unchanged' } as const)
            : proxyApplier.applyAll(latestProxy)
        })
      }

      if (oldFull.app.defaultSaveDir !== newFull.app.defaultSaveDir) {
        await supervisor.applyDefaultSaveDir(newFull.app.defaultSaveDir)
      }

      if (
        oldFull.app.browserBridgeEnabled !== newFull.app.browserBridgeEnabled
      ) {
        await bridgeControl?.setEnabled(newFull.app.browserBridgeEnabled)
      }
      if (oldFull.bridge.fixedPort !== newFull.bridge.fixedPort) {
        await bridgeControl?.restart()
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

      return result
    },

    [Commands.UpdateGeoIPDatabase]: createUpdateGeoIPDatabaseHandler({
      geoipManager,
    }),

    [Commands.RequestDefaultTorrentHandler]: async () => ({ ok: false }),

    [Commands.SyncTrackers]: async () => trackerManager.syncAndCurate(),

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
      // Server mode lacks db-backed isPrivate persistence; rely on the
      // in-memory DownloadTask.bt.isPrivate (false in current server impl
      // until proper persistence lands).
      const isPrivate = task.bt?.isPrivate ?? false
      await trackerManager.syncBtTracker(task.id, params.engineGid, isPrivate)
    },

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

      const secretFields = pluginSecretFields(indexed.manifest)

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

    [Commands.CheckPluginUpdates]: async (payload: unknown) => {
      const parsed = checkPluginUpdatesPayloadSchema.parse(payload)
      if (parsed?.force) await registryClient.refresh()
      const entries = await registryClient.list(hostVersion)
      return scanForUpdates(pluginRegistry.list(), entries).filter(
        (update) => update.channel === 'community'
      )
    },

    [Commands.InstallPlugin]: async (payload: unknown) => {
      const result = await pluginInstallService.stage(payload, pluginHost)
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

    [Commands.ConfirmPluginInstall]: async (payload: unknown) => {
      const parsed = z
        .object({
          stagingId: z.string().min(1),
          grants: z.record(z.string(), z.enum(['granted', 'denied'])),
        })
        .parse(payload)
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

    [Commands.MarkNotificationRead]: async (id: string) =>
      notificationCenter.markRead(id),

    [Commands.MarkAllNotificationsRead]: async () =>
      notificationCenter.markAllRead(),

    [Commands.DeleteNotification]: async (id: string) =>
      notificationCenter.delete(id),

    [Commands.ClearNotifications]: async () => notificationCenter.clear(),

    // Electron-scoped commands (window chrome, tray, dialog, deep-links,
    // auto-updater, NAT) are intentionally omitted; the web renderer
    // handles them locally or renders a no-op.
  }
}

function proxyChanged(a: ProxySettings, b: ProxySettings): boolean {
  return JSON.stringify(a) !== JSON.stringify(b)
}
