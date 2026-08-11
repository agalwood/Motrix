import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TaskActivityService, TaskActivityStore } from '@core/activity'
import { Aria2Adapter } from '@core/engine/aria2/aria2-adapter'
import { Aria2ConfigBuilder } from '@core/engine/aria2/aria2-config-builder'
import { Aria2ProcessManager } from '@core/engine/aria2/aria2-process-manager'
import { Aria2RpcClient } from '@core/engine/aria2/aria2-rpc-client'
import { JsonRpcProtocol } from '@core/engine/aria2/json-rpc-protocol'
import {
  PollingScheduler,
  type PollingTaskUpdateSource,
} from '@core/engine/aria2/polling-scheduler'
import { translateRawToTask } from '@core/engine/aria2/translate'
import type { Aria2RawStatus } from '@core/engine/aria2/types'
import { WebSocketTransport } from '@core/engine/aria2/web-socket-transport'
import {
  ENGINE_READY_TIMEOUT_MS,
  EngineSupervisor,
} from '@core/engine/engine-supervisor'
import { EventBus } from '@core/events/event-bus'
import { pathExists } from '@core/fs/path-exists'
import { LocaleCoordinator } from '@core/i18n/locale-coordinator'
import {
  AsyncWorkTracker,
  createTaskInspectorActivityQuery,
  type RuntimeTransitionInput,
  TaskInspectorActivityRuntime,
  TaskInspectorActivityStore,
  taskInspectorActivityEnvironment,
} from '@core/inspector-activity'
import { newTaskId } from '@core/lib/ids'
import { getLogger, initLogger } from '@core/logger'
import { registerEngineFailureSubscriber } from '@core/notifications/engine-failure-subscriber'
import { NotificationCenter } from '@core/notifications/notification-center'
import { createNotificationOccurrenceConsumer } from '@core/notifications/occurrence-consumer'
import { wireCommandSystem } from '@core/plugin/commands/wire'
import { ActivationDispatcher } from '@core/plugin/host/activation-dispatcher'
import {
  PluginHost,
  parsePluginIdleDisposeMs,
} from '@core/plugin/host/plugin-host'
import { PluginRegistry } from '@core/plugin/plugin-registry'
import { RegistryClient } from '@core/plugin/registry/registry-client'
import { PluginStateStore } from '@core/plugin/state/plugin-state-store'
import { MotrixDatabase } from '@core/session/motrix-database'
import { SessionManager } from '@core/session/session-manager'
import { SettingsManager } from '@core/settings/settings-manager'
import { SpeedLimitController } from '@core/speed-limit/speed-limit-controller'
import {
  SpeedHistoryStore,
  StatsAggregator,
  TaskSpeedHistoryStore,
  TransferStatsRuntime,
} from '@core/stats'
import {
  pauseTask as pauseTaskAction,
  resumeTask as resumeTaskAction,
} from '@core/task/actions'
import { finalizeTask } from '@core/task/actions/finalize-task'
import { removeTask } from '@core/task/actions/remove-task'
import { commitPolledTerminalTransition } from '@core/task/actions/shared'
import { handleCreateTask } from '@core/task/create-task-handler'
import { FileCleanupServiceImpl } from '@core/task/file-cleanup-service'
import { FinalNamePickerImpl } from '@core/task/final-name-picker'
import {
  hasEngineTaskDelta,
  mergeEngineTask,
} from '@core/task/merge-engine-task'
import { createFailureLogConsumer } from '@core/task/occurrences/log-consumer'
import { OccurrenceDispatcher } from '@core/task/occurrences/occurrence-dispatcher'
import { shouldSkipEngineCompletionFinalize } from '@core/task/should-skip-engine-completion-finalize'
import { slimTasksForBroadcast } from '@core/task/slim-task-for-broadcast'
import { TaskManager } from '@core/task/task-manager'
import {
  defaultRecoveryFs,
  TaskRecoveryServiceImpl,
} from '@core/task/task-recovery-service'
import { TaskUpdatePublisher } from '@core/task/task-update-publisher'
import { TorrentMetaStoreImpl } from '@core/task/torrent-meta-store'
import { MagnetTracker } from '@core/torrent/magnet-tracker'
import { shouldSkipForPendingMagnetMetadata } from '@core/torrent/metadata-task-filter'
import { TorrentParser } from '@core/torrent/torrent-parser'
import {
  TrackerManager,
  TrackerProber,
  TrackerStore,
  TrackerSyncer,
} from '@core/tracker'
import { resolveSupportedLocale } from '@shared/constants/locales'
import { Events } from '@shared/protocol/events'
import type { Handler } from '@shared/protocol/handler-types'
import { REGISTRY_CACHE_FILENAME } from '@shared/schemas/registry'
import type { AppSettings } from '@shared/types/settings'
import type { DownloadTask } from '@shared/types/task'
import { TaskType } from '@shared/types/task'
import pino from 'pino'
import {
  bootstrapBridgeForServer,
  type ServerBridgeRuntime,
} from './bridge/bootstrap'
import {
  createServerDownloadPathPolicy,
  resolveServerDefaultSaveDir,
} from './download-path-policy'
import { createApp } from './http/app'
import { buildServerCommandHandlers } from './ipc/commands'
import { buildServerQueryHandlers } from './ipc/queries'
import { provisionOperatorToken } from './operator-token'
import { createNodePlatformServices } from './platform/services'
import { createServerCapabilityHost } from './plugin/capability-host'
import { startDevWatcher } from './plugin/dev-watcher'
import { resolveServerPluginsDir } from './plugin/plugins-dir'
import { createServerProxyApplier } from './proxy/wiring'
import { registerTasksBulkRoutes } from './routes/tasks-bulk'
import {
  createServerExitCoordinator,
  createServerShutdown,
  runServerStartup,
  type ServerShutdownActions,
} from './shutdown'
import {
  createServerPersistTask,
  createServerPersistTaskWithOccurrence,
} from './task-persistence'

let requestActiveServerExit: ((code: number) => Promise<void>) | null = null

async function main() {
  // ─── Logger ───────────────────────────────────────────────────
  initLogger(pino({ level: process.env.LOG_LEVEL ?? 'info' }))
  const log = getLogger('server')

  // ─── Platform ─────────────────────────────────────────────────
  const platform = createNodePlatformServices()
  log.info({ platform }, 'boot')

  // The cleanup coordinator exists before the first fallible acquisition.
  // Each resource replaces its no-op slot immediately when ownership is
  // obtained, so any later startup failure (or signal during startup) uses the
  // same idempotent teardown path.
  const shellAsyncWork = new AsyncWorkTracker()
  const pollingNotificationUnsubscribers: Array<() => void> = []
  let acceptingTransferStats = true
  const shutdownActions: ServerShutdownActions = {
    gateShellWork: () => {
      log.info('shutting down')
      acceptingTransferStats = false
      return shellAsyncWork.stopAndDrain()
    },
    stopPolling: () => {},
    closeIngress: () => {},
    closeBridge: () => {},
    unsubscribeProducers: () => {},
    drainDevWatcher: () => {},
    drainPluginHost: () => {},
    drainMagnet: () => {},
    drainSession: () => {},
    disposeActivity: () => {},
    disposeTransferStats: () => {},
    disposeTracker: () => {},
    stopSpeedLimit: () => {},
    stopEngine: () => {},
    closeDatabase: () => {},
  }
  const shutdown = createServerShutdown(shutdownActions, (err, label) => {
    log.warn({ err, label }, 'shutdown step failed')
  })
  let startupExitCode = 0
  const requestExit = createServerExitCoordinator(shutdown, (code) => {
    process.exit(Math.max(code, startupExitCode))
  })
  requestActiveServerExit = requestExit
  const shutdownAndExit = () => {
    void requestExit(0)
  }
  process.once('SIGINT', shutdownAndExit)
  process.once('SIGTERM', shutdownAndExit)

  const runShellAsyncWork = (
    label: string,
    operation: () => Promise<void>
  ): void => {
    if (!shellAsyncWork.isAccepting()) return
    void shellAsyncWork
      .run(async () => {
        if (!shellAsyncWork.isAccepting()) return
        await operation()
      })
      .catch((err) => {
        if (
          !shellAsyncWork.isAccepting() &&
          err instanceof Error &&
          err.message === 'AsyncWorkTracker is stopped'
        ) {
          return
        }
        log.warn({ err, label }, 'detached shell work failed')
      })
  }

  // ─── Core Services ────────────────────────────────────────────
  const eventBus = new EventBus({
    onListenerError: (channel, err) =>
      log.warn({ err, channel }, 'event listener threw'),
  })
  const taskManager = new TaskManager()
  // Coalesces the per-commit TaskUpdated fan-out (see
  // docs/superpowers/specs/2026-08-07-task-updated-emit-coalescing-design.md).
  // Phase 1: only commitTaskUpdate routes through it, via the optional
  // publishTaskUpdate/publishTaskUpdateNow deps handed to task actions below.
  // Same slim projection as the desktop shell (option E).
  const taskUpdatePublisher = new TaskUpdatePublisher({
    taskManager: { getAll: () => slimTasksForBroadcast(taskManager.getAll()) },
    eventBus,
  })
  const publishTaskUpdate = () => taskUpdatePublisher.publish()
  const publishTaskUpdateNow = () => taskUpdatePublisher.publishNow()
  shutdownActions.flushTaskUpdates = () => taskUpdatePublisher.flush()
  const statsAggregator = new StatsAggregator()
  const speedHistoryStore = new SpeedHistoryStore()
  const taskSpeedHistoryStore = new TaskSpeedHistoryStore()

  eventBus.on(Events.TaskUpdated, (...args) => {
    const tasks = args[0]
    if (Array.isArray(tasks)) {
      taskSpeedHistoryStore.append(tasks as readonly DownloadTask[])
    }
  })

  // speedLimitController is assigned below, after supervisor is available.
  // The closure captures the variable by reference so changes after assignment
  // are visible here.
  let speedLimitController: SpeedLimitController | undefined

  const configuredDefaultSaveDir = resolveServerDefaultSaveDir(
    process.env,
    path.join(os.homedir(), 'Downloads')
  )
  const settingsManager = new SettingsManager(
    path.join(platform.userDataDir, 'settings.json'),
    {
      defaultSaveDir: configuredDefaultSaveDir,
      onChange: (old, updated) => {
        eventBus.emit(Events.SettingsChanged, { old, updated })
        if (
          speedLimitController &&
          JSON.stringify(old.speedLimit) !== JSON.stringify(updated.speedLimit)
        ) {
          void speedLimitController.recompute()
        }
      },
    }
  )
  await settingsManager.load()
  if (!shellAsyncWork.isAccepting()) return
  const hasDefaultSaveDirOverride = Boolean(
    process.env.MOTRIX_DEFAULT_SAVE_DIR?.trim()
  )
  const effectiveDefaultSaveDir = hasDefaultSaveDirOverride
    ? configuredDefaultSaveDir
    : settingsManager.getApp().defaultSaveDir
  const downloadPathPolicy = await createServerDownloadPathPolicy({
    defaultSaveDir: effectiveDefaultSaveDir,
    allowedSaveDirsValue: process.env.MOTRIX_ALLOWED_SAVE_DIRS,
  })
  if (
    hasDefaultSaveDirOverride &&
    settingsManager.getApp().defaultSaveDir !== effectiveDefaultSaveDir
  ) {
    await settingsManager.update({
      app: { defaultSaveDir: effectiveDefaultSaveDir },
    })
  }
  log.info(
    {
      defaultSaveDir: settingsManager.getApp().defaultSaveDir,
      allowedSaveDirs: downloadPathPolicy.allowedSaveDirs,
    },
    'download path contract ready'
  )
  if (!shellAsyncWork.isAccepting()) return
  const resolveServerLocale = (settingsLanguage: string) =>
    resolveSupportedLocale(
      settingsLanguage,
      process.env.MOTRIX_HOST_LANGUAGE,
      process.env.LANG
    )
  let hostLanguage = resolveServerLocale(settingsManager.getApp().language)
  let pluginLocaleTargets: {
    registry: PluginRegistry
    capabilityHost: { setLocale(locale: typeof hostLanguage): void }
  } | null = null
  const localeCoordinator = new LocaleCoordinator({
    initialLocale: hostLanguage,
    onAppliedLocale: (locale) => {
      hostLanguage = locale
    },
    applyLocale: async (locale, isCurrent) => {
      const targets = pluginLocaleTargets
      if (targets) {
        await targets.registry.setHostLanguageTransaction(locale, {
          commitHostLocale: () => {
            targets.capabilityHost.setLocale(locale)
          },
          rollbackHostLocale: (previousLanguage) => {
            targets.capabilityHost.setLocale(previousLanguage)
          },
          shouldCommit: isCurrent,
        })
      }
    },
    emitLocaleChanged: (language) => {
      eventBus.emit(Events.LocaleChanged, { language })
    },
  })
  const enqueueLocaleUpdate = (settingsLanguage: string) =>
    localeCoordinator.update(resolveServerLocale(settingsLanguage), true)
  eventBus.on(Events.SettingsChanged, (payload: unknown) => {
    const { old, updated } = payload as {
      old: AppSettings
      updated: AppSettings
    }
    if (old.app.language === updated.app.language) return
    runShellAsyncWork('locale update', () =>
      enqueueLocaleUpdate(updated.app.language)
    )
  })

  // ─── aria2 Infrastructure ─────────────────────────────────────
  const transport = new WebSocketTransport()
  const protocol = new JsonRpcProtocol(transport)
  const processManager = new Aria2ProcessManager({
    ownershipFilePath: path.join(platform.userDataDir, 'aria2-owner.json'),
  })
  const configBuilder = new Aria2ConfigBuilder(
    path.join(platform.extraResourceDir, 'aria2.conf'),
    platform.userDataDir
  )

  // ─── Database ─────────────────────────────────────────────────
  const db = new MotrixDatabase(path.join(platform.userDataDir, 'motrix.db'))
  shutdownActions.closeDatabase = () => db.close()
  db.init()

  // Delivers durably-persisted terminal/diagnosis occurrences to in-process
  // consumers (timeline, failure log); see the "occurrence consumer
  // registration" marker below, which runs before session restore, startup
  // recovery, and drainAtStartup().
  const occurrenceDispatcher = new OccurrenceDispatcher({
    listUndispatched: () => db.listUndispatchedOccurrences(),
    markDispatched: (occurrenceId) => db.markOccurrenceDispatched(occurrenceId),
    log,
  })
  const taskActivityService = new TaskActivityService(
    new TaskActivityStore(db.database),
    eventBus,
    {
      onError: (err, context) => {
        log.warn({ err, ...context }, 'task activity persistence failed')
      },
    }
  )
  const activityEnvironment = taskInspectorActivityEnvironment(process.env)
  const taskInspectorActivityRuntime = new TaskInspectorActivityRuntime(
    new TaskInspectorActivityStore(db.database),
    eventBus,
    {
      ...activityEnvironment.runtime,
      onError: (err, context) => {
        log.warn(
          { err, ...context },
          'task inspector activity persistence failed'
        )
      },
    }
  )
  shutdownActions.disposeActivity = () => taskInspectorActivityRuntime.dispose()
  const taskInspectorActivityQuery = createTaskInspectorActivityQuery(
    taskInspectorActivityRuntime,
    activityEnvironment.query
  )
  const transferStats = new TransferStatsRuntime(db.database, eventBus, {
    onError: (err) => {
      log.warn({ err }, 'transfer statistics persistence failed')
    },
  })
  shutdownActions.disposeTransferStats = () => {
    if (!transferStats.dispose()) {
      log.warn('transfer statistics final checkpoint failed')
    }
  }

  // ─── Plugin runtime ─────────────────────────────────────────
  const { pluginsDir, builtinDir } = await resolveServerPluginsDir(
    platform.userDataDir
  )
  if (!shellAsyncWork.isAccepting()) return
  const pluginStateStore = new PluginStateStore(db.database)
  const devPath = process.env.MOTRIX_PLUGIN_DEV_PATH
  const pluginRegistry = new PluginRegistry({
    pluginsDir,
    builtinDir,
    stateStore: pluginStateStore,
    hostVersion: process.env.MOTRIX_APP_VERSION ?? '2.0.0',
    hostLanguage,
    devPath,
  })
  await pluginRegistry.discover()
  if (!shellAsyncWork.isAccepting()) return
  const pluginCapHost = await createServerCapabilityHost({
    appVersion: process.env.MOTRIX_APP_VERSION ?? '2.0.0',
    hostLanguage,
    db: db.database,
    userDataDir: platform.userDataDir,
    pluginsDir,
    settingsManager,
    // TODO Task 22: wire settingsManager config lookup
    configReader: (_pluginId) => ({}),
    // TODO Plan F: derive from manifest contributes.configuration schema
    secretFieldsFor: (_pluginId) => new Set(),
    manifestCommandIdsFor: (pluginId) => {
      const cmds = pluginRegistry.get(pluginId)?.manifest.contributes.commands
      return new Set(cmds?.map((c) => c.id) ?? [])
    },
    localeSnapshotFor: (pluginId) =>
      pluginRegistry.getLocaleDictionaries(pluginId),
  })
  pluginLocaleTargets = {
    registry: pluginRegistry,
    capabilityHost: pluginCapHost,
  }
  await localeCoordinator.reconcile()
  if (!shellAsyncWork.isAccepting()) return
  const serverDir = path.dirname(fileURLToPath(import.meta.url))
  const pluginHost = new PluginHost({
    registry: pluginRegistry,
    stateStore: pluginStateStore,
    capabilityHost: pluginCapHost,
    workerScriptPath: path.join(
      serverDir,
      '../core/plugin/host/quick-js-worker.cjs'
    ),
    appVersion: process.env.MOTRIX_APP_VERSION ?? '2.0.0',
    runtime: 'server',
    hostLanguage,
    idleDisposeMs: parsePluginIdleDisposeMs(
      process.env.MOTRIX_PLUGIN_IDLE_DISPOSE_MS
    ),
  })
  shutdownActions.drainPluginHost = () => pluginHost.shutdown()
  // Wire Plan D: cross-plugin command safeguards (schema cache + rate limit
  // + caller throttle + chain depth + audit) and bind the invoker to the
  // capability host. Must run AFTER registry.discover() so manifest schemas
  // can be compiled at install time.
  wireCommandSystem({
    registry: pluginRegistry,
    host: pluginHost,
    capabilityHost: pluginCapHost,
    pluginsDir,
  })

  const pluginActivation = new ActivationDispatcher(pluginRegistry, pluginHost)
  let devWatcherHandle: { close(): Promise<void> } | null = null
  shutdownActions.drainDevWatcher = () => devWatcherHandle?.close()

  // ─── Engine + Session ─────────────────────────────────────────
  const engineSettings = settingsManager.getEngine()

  const rpcClient = new Aria2RpcClient(
    transport,
    protocol,
    engineSettings.rpcSecret
  )
  const adapter = new Aria2Adapter(rpcClient)
  shutdownActions.unsubscribeProducers = () => {
    let firstError: unknown
    for (const unsubscribe of pollingNotificationUnsubscribers.splice(0)) {
      try {
        unsubscribe()
      } catch (err) {
        firstError ??= err
      }
    }
    try {
      adapter.dispose()
    } catch (err) {
      firstError ??= err
    }
    if (firstError !== undefined) {
      throw firstError
    }
  }
  const supervisor = new EngineSupervisor(
    eventBus,
    settingsManager,
    processManager,
    configBuilder,
    rpcClient,
    adapter
  )
  shutdownActions.stopEngine = () => supervisor.stop()
  const sessionManager = new SessionManager(taskManager, rpcClient, db, adapter)
  shutdownActions.drainSession = () => sessionManager.stopAndDrain()
  const persistTask = createServerPersistTask(taskManager, sessionManager)
  const persistTaskWithOccurrence =
    createServerPersistTaskWithOccurrence(sessionManager)

  // ─── Speed Limit Controller ───────────────────────────────────
  // Constructed immediately after supervisor so setEffectiveLimitsProvider
  // is registered before the first supervisor.start() call below.
  speedLimitController = new SpeedLimitController({
    getSettings: () => settingsManager.get().speedLimit,
    applyLimits: (limits) => supervisor.applySpeedLimits(limits),
    getEngineState: () => supervisor.getState(),
    emit: (channel, payload) => eventBus.emit(channel, payload),
  })
  shutdownActions.stopSpeedLimit = () => speedLimitController?.stop()
  supervisor.setEffectiveLimitsProvider(
    () => speedLimitController?.getEffective() ?? { download: 0, upload: 0 }
  )

  // When the engine reaches Ready (cold-start or reconnect), force a
  // limit push so aria2 starts with the correct effective limits.
  eventBus.on(
    Events.EngineRecovered as Parameters<typeof eventBus.on>[0],
    () => {
      void speedLimitController?.onEngineReady()
    }
  )

  // ─── Tracker ──────────────────────────────────────────────────
  const trackerStore = new TrackerStore(
    path.join(platform.userDataDir, 'tracker.json')
  )
  const trackerSyncer = new TrackerSyncer()
  const trackerProber = new TrackerProber()
  const trackerManager = new TrackerManager(
    settingsManager,
    rpcClient,
    eventBus,
    trackerSyncer,
    trackerProber,
    trackerStore,
    {
      pauseTask: (taskId) =>
        pauseTaskAction(taskId, {
          taskManager,
          adapter,
          eventBus,
          log,
          persistTask,
          persistTaskWithOccurrence,
          occurrenceDispatcher,
          recordTransition: (input) =>
            taskInspectorActivityRuntime.recordTransition(input),
          runTaskMutation: (taskIds, operation) =>
            taskInspectorActivityRuntime.runTaskMutation(taskIds, operation),
          publishTaskUpdate,
          publishTaskUpdateNow,
        }),
      resumeTask: (taskId) =>
        resumeTaskAction(taskId, {
          taskManager,
          adapter,
          eventBus,
          log,
          persistTask,
          persistTaskWithOccurrence,
          occurrenceDispatcher,
          recordTransition: (input) =>
            taskInspectorActivityRuntime.recordTransition(input),
          runTaskMutation: (taskIds, operation) =>
            taskInspectorActivityRuntime.runTaskMutation(taskIds, operation),
          publishTaskUpdate,
          publishTaskUpdateNow,
        }),
    }
  )
  shutdownActions.disposeTracker = () => trackerManager.stopAndDrain()

  // ─── Proxy Applier ────────────────────────────────────────────
  // Server runtime has no Electron session, so the applier is
  // constructed without `applyUpdateAppProxy`. The applier early-returns
  // on the `download` scope until the engine is Ready, so this initial
  // applyAll is mainly for symmetry with the main runtime and to prime
  // the tracker proxy cache.
  const proxyApplier = createServerProxyApplier(supervisor, trackerManager)

  // ─── Polling ──────────────────────────────────────────────────
  async function handlePolledTasks(
    rawTasks: Aria2RawStatus[],
    source: PollingTaskUpdateSource
  ): Promise<void> {
    let dirty = false
    for (const raw of rawTasks) {
      if (shouldSkipForPendingMagnetMetadata(raw, magnetTracker)) {
        continue
      }
      // A remove/GID swap can complete after this poll's RPC captured the old
      // row but before reconciliation runs. Do not reinterpret that explicitly
      // retired ownership as a brand-new aria2 orphan.
      if (taskManager.isEngineTaskIdRetired(raw.gid)) {
        continue
      }

      const translated = translateRawToTask(raw)
      const existing = taskManager.getByEngineTaskId(raw.gid)
      if (existing) {
        const merged = mergeEngineTask(existing, translated)
        // No observable delta: nothing to store, nothing to publish. This
        // gate (mirroring the desktop shell) is what keeps an idle server
        // from broadcasting the full snapshot every poll tick.
        if (!hasEngineTaskDelta(existing, merged)) continue
        // A poll-detected transition into Completed/Error is committed
        // through the occurrence-aware durable path (task row + occurrence
        // row, one transaction) — this loop otherwise never persists a
        // task durably at all, so this is the only durable write for this
        // transition, not a replacement for a batch save. Awaited inline
        // and published only on success: a terminal status that reached
        // clients without its row on disk would revert on the next restart
        // with no occurrence ever recorded. Terminal-vs-not is owned by
        // commitPolledTerminalTransition itself — a non-terminal change
        // comes back as 'not-terminal' with nothing written.
        const outcome =
          existing.status !== merged.status
            ? await commitPolledTerminalTransition(existing.status, merged, {
                persistTaskWithOccurrence,
                occurrenceDispatcher,
                publish: (task) => taskManager.set(task.id, task),
                runTaskMutation: (taskIds, operation) =>
                  taskInspectorActivityRuntime.runTaskMutation(
                    taskIds,
                    operation
                  ),
                log,
              })
            : 'not-terminal'
        // Nothing was published and nothing is durable: leave the prior
        // in-memory state alone so the next poll retries.
        if (outcome === 'persist-failed') continue
        if (outcome !== 'published') taskManager.set(existing.id, merged)
        dirty = true
      } else {
        const id = newTaskId()
        taskManager.set(id, { ...translated, id })
        log.info(
          { gid: raw.gid, taskId: id, name: translated.name },
          'new task discovered from engine'
        )
        dirty = true
      }
    }
    // Publish the FULL task snapshot (matching the desktop + every other
    // core site; the publisher snapshots getAll() at flush time). The MDXP
    // SSE firehose derives $/task/* per task from this array; a payload-less
    // emit would silently drop the per-task stream.
    const tasks = taskManager.getAll()
    if (source === 'authoritative-poll') {
      await taskInspectorActivityRuntime.recordAuthoritativeReconnectAnchors(
        tasks
      )
    }
    taskInspectorActivityRuntime.recordSamples(tasks)
    if (dirty) publishTaskUpdate()
  }

  const pollingScheduler = new PollingScheduler(
    rpcClient,
    eventBus,
    (stats) => {
      statsAggregator.update(stats)
      speedHistoryStore.append(stats)
      // A stopped scheduler may still finish an RPC that was already in
      // flight. Ignore that late sample once shutdown owns the final flush.
      if (acceptingTransferStats) transferStats.record(stats)
      eventBus.emit(Events.StatsUpdated, stats)
    },
    handlePolledTasks
  )
  shutdownActions.stopPolling = () => pollingScheduler.stopAndDrain()

  // ─── Task lifecycle helpers ───────────────────────────────────
  const finalNamePicker = new FinalNamePickerImpl({
    exists: pathExists,
  })
  const torrentMetaStore = new TorrentMetaStoreImpl(
    path.join(platform.userDataDir, 'torrents')
  )
  const fileCleanupService = new FileCleanupServiceImpl({
    async removePathRecursive(absPath: string): Promise<void> {
      await fs.rm(absPath, { recursive: true, force: true })
    },
  })
  const torrentParser = new TorrentParser()
  const magnetTracker = new MagnetTracker(
    rpcClient,
    eventBus,
    settingsManager,
    db,
    taskManager,
    torrentParser,
    taskActivityService,
    {
      publishTaskUpdate,
      publishTaskUpdateNow,
      parentTaskCreated: (task, persistParent) =>
        taskInspectorActivityRuntime.parentTaskCreated(task, persistParent),
      recordTransition: (input) =>
        taskInspectorActivityRuntime.recordTransition(input),
      deleteParentTask: (taskId, deleteParent) =>
        taskInspectorActivityRuntime.deleteParentTask(taskId, deleteParent),
      runTaskMutation: (taskIds, operation) =>
        taskInspectorActivityRuntime.runTaskMutation(taskIds, operation),
      runExclusivePersistence: (operation) =>
        sessionManager.runExclusivePersistence(operation),
      torrentMetaDir: path.join(platform.userDataDir, 'torrents'),
      occurrenceDispatcher,
    }
  )
  shutdownActions.drainMagnet = () => magnetTracker.stopAndDrain()

  // Task 14: notificationCenter must exist before buildServerCommandHandlers/
  // buildServerQueryHandlers below (they take it in their context), which is
  // earlier than Task 13's `registerEngineFailureSubscriber` call — that call
  // stays right before supervisor.start() further down in startServer(); only
  // the construction (which depends on nothing engine-related — just db/
  // eventBus/log, all already available here) is hoisted this far up.
  const notificationCenter = new NotificationCenter({
    store: db,
    emit: eventBus.emit.bind(eventBus),
    log,
  })

  // ─── HTTP App ─────────────────────────────────────────────────
  const commandHandlers = buildServerCommandHandlers({
    supervisor,
    settingsManager,
    rpcClient,
    adapter,
    trackerManager,
    aria2BinaryPath: platform.aria2BinaryPath,
    finalNamePicker,
    torrentMetaStore,
    taskManager,
    fileCleanupService,
    eventBus,
    proxyApplier,
    motrixDatabase: db,
    notificationCenter,
    taskPersistence: sessionManager,
    pluginRegistry,
    pluginStateStore,
    pluginHost,
    capabilityHost: pluginCapHost,
    userDataDir: platform.userDataDir,
    pluginsDir,
    pluginActivation,
    magnetTracker,
    activityRecorder: taskActivityService,
    persistTask,
    persistTaskWithOccurrence,
    occurrenceDispatcher,
    recordTransition: (input) =>
      taskInspectorActivityRuntime.recordTransition(input),
    deleteParentTasks: (taskIds, deleteParents) =>
      taskInspectorActivityRuntime.deleteParentTasks(taskIds, deleteParents),
    runTaskMutation: (taskIds, operation) =>
      taskInspectorActivityRuntime.runTaskMutation(taskIds, operation),
    parentTaskCreated: (task, persistParent) =>
      taskInspectorActivityRuntime.parentTaskCreated(task, persistParent),
    publishTaskUpdate,
    publishTaskUpdateNow,
    downloadPathPolicy,
  })
  const registryClient = new RegistryClient({
    cachePath: path.join(platform.userDataDir, REGISTRY_CACHE_FILENAME),
  })
  const queryHandlers = buildServerQueryHandlers({
    taskManager,
    statsAggregator,
    speedHistoryStore,
    transferStats,
    taskActivityService,
    taskSpeedHistoryStore,
    taskInspectorActivityRuntime: taskInspectorActivityQuery,
    supervisor,
    settingsManager,
    trackerManager,
    engineAdapter: adapter,
    notificationCenter,
    pluginRegistry,
    registryClient,
    pluginsDir,
    hostVersion: process.env.MOTRIX_APP_VERSION ?? '2.0.0',
    userDataDir: platform.userDataDir,
    speedLimitController,
    downloadPathPolicy,
  })

  const rendererDir =
    process.env.MOTRIX_RENDERER_DIR ??
    path.resolve(serverDir, '..', 'renderer-web')

  // bridge:* RPC handlers are populated AFTER the (non-fatal, later) bridge
  // bootstrap; createApp captures these by reference, so a post-hoc Object.assign
  // makes the routes see them.
  const bridgeCommandHandlers: Record<string, Handler> = {}
  const bridgeQueryHandlers: Record<string, Handler> = {}

  // Operator (control-plane) secret — provisioned INDEPENDENTLY of the
  // (non-fatal) MDXP bridge so a bridge bootstrap failure can never lock the web
  // UI behind an unrecoverable in-memory token (Spec 9 / F1). Distinct from the
  // agent /mdxp localToken the bridge self-mints below.
  const operator = await provisionOperatorToken({
    dataDir: platform.userDataDir,
  })
  if (!shellAsyncWork.isAccepting()) return
  log.info(
    { source: operator.source, path: operator.path },
    'operator token provisioned'
  )

  const app = await createApp({
    commandHandlers,
    queryHandlers,
    bridgeCommandHandlers,
    bridgeQueryHandlers,
    eventBus,
    rendererDir,
    operatorAuth: { operatorToken: operator.token },
  })
  shutdownActions.closeIngress = () => app.close()
  if (!shellAsyncWork.isAccepting()) {
    await app.close()
    return
  }

  registerTasksBulkRoutes(app, {
    taskManager,
    adapter,
    eventBus,
    log,
    persistTask,
    recordTransition: (input) =>
      taskInspectorActivityRuntime.recordTransition(input),
    runTaskMutation: (taskIds, operation) =>
      taskInspectorActivityRuntime.runTaskMutation(taskIds, operation),
    publishTaskUpdate,
    publishTaskUpdateNow,
  })

  // Startup itself is tracked below so a signal cannot race past cleanup and
  // publish a resource after its corresponding shutdown step has already run.
  let bridgeRuntime: ServerBridgeRuntime | null = null
  shutdownActions.closeBridge = () => bridgeRuntime?.shutdown()

  const startServer = async (): Promise<void> => {
    try {
      await pluginActivation.dispatch({ kind: 'startup' })
    } catch (err) {
      if (!shellAsyncWork.isAccepting()) {
        await pluginHost.shutdown()
        return
      }
      throw err
    }
    if (!shellAsyncWork.isAccepting()) {
      await pluginHost.shutdown()
      return
    }

    speedLimitController.start()

    if (devPath) {
      runShellAsyncWork('dev watcher start', async () => {
        const handle = await startDevWatcher(
          devPath,
          pluginRegistry,
          pluginHost,
          process.env.MOTRIX_APP_VERSION ?? '2.0.0'
        )
        if (!shellAsyncWork.isAccepting()) {
          await handle.close()
          return
        }
        devWatcherHandle = handle
      })
    }

    runShellAsyncWork('initial proxy apply', async () => {
      try {
        await proxyApplier.applyAll(settingsManager.getProxy())
      } catch (err) {
        log.warn({ err }, 'initial proxy apply failed')
      }
    })
    runShellAsyncWork('tracker manager init', async () => {
      try {
        await trackerManager.init()
      } catch (err) {
        log.warn(
          { err },
          'trackerManager init failed — continuing without tracker sync'
        )
      }
    })

    // ─── Engine Start & Session Restore ───────────────────────────
    log.info({ binaryPath: platform.aria2BinaryPath }, 'resolved aria2 binary')

    // Engine-incident notifications (Task 13): wired BEFORE supervisor.start()
    // runs, NOT next to the occurrence-consumer registration further down.
    // recordFailure() emits EngineFailureOccurred from inside the start()
    // call below, so a cold-start failure fires before the catch below even
    // runs. Wiring the subscriber only afterward would mean the very failure
    // this feature exists to surface — the first boot never reaching Ready —
    // has no subscriber and is silently dropped. Grace-clean stale
    // engine-scoped ledger rows FIRST (no replay source for an
    // EngineFailurePayload survives a boot — its incidentId is only unique
    // within the boot that produced it), THEN subscribe. `notificationCenter`
    // itself was constructed earlier (Task 14 needs it in
    // buildServerCommandHandlers/buildServerQueryHandlers, built before
    // startServer() runs) — reused here via closure.
    registerEngineFailureSubscriber({
      motrixDb: db,
      eventBus,
      notificationCenter,
      log,
    })

    try {
      await supervisor.start(platform.aria2BinaryPath)
    } catch (err) {
      log.error({ err }, 'engine start failed')
    }
    if (!shellAsyncWork.isAccepting()) return

    // Discrete lifecycle transitions (including terminal media states) must be
    // durable before their coordinator resolves. save() is a serialized,
    // rejecting hard barrier, matching the Electron shell contract.
    // Reads live `EngineSettings` so user changes via the Settings UI
    // are honored on every reseed (per-finalize, not memoized). Units
    // match aria2's RPC contract: `seedTime` is minutes, `seedRatio` is
    // a unit-less share ratio.
    const buildFinalizeDeps = () => ({
      taskManager: {
        getById: (id: string) => taskManager.getById(id),
        getAll: () => taskManager.getAll(),
        set: (id: string, task: DownloadTask) => taskManager.set(id, task),
        setReservedEngineTaskOwner: (
          id: string,
          task: DownloadTask,
          engineTaskId: string
        ) => taskManager.setReservedEngineTaskOwner(id, task, engineTaskId),
        reserveEngineTaskId: (engineTaskId: string) =>
          taskManager.reserveEngineTaskId(engineTaskId),
        releaseEngineTaskIdReservation: (engineTaskId: string) =>
          taskManager.releaseEngineTaskIdReservation(engineTaskId),
        retireEngineTaskIdReservation: (engineTaskId: string) =>
          taskManager.retireEngineTaskIdReservation(engineTaskId),
        persist: persistTask,
      },
      persistTaskWithOccurrence,
      occurrenceDispatcher,
      publishTaskUpdate,
      publishTaskUpdateNow,
      adapter,
      fs: {
        renameAtomic: async (src: string, dst: string) => {
          await fs.rename(src, dst)
        },
        removePathRecursive: async (absPath: string) => {
          await fs.rm(absPath, { recursive: true, force: true })
        },
      },
      torrentMetaStore,
      settings: {
        get: () => {
          const engine = settingsManager.getEngine()
          return {
            bt: { seedTime: engine.seedTime, seedRatio: engine.seedRatio },
          }
        },
      },
      eventBus,
      activityRecorder: taskActivityService,
      recordTransition: (input: RuntimeTransitionInput) =>
        taskInspectorActivityRuntime.recordTransition(input),
      runTaskMutation: <T>(
        taskIds: readonly string[],
        operation: () => Promise<T>
      ) => taskInspectorActivityRuntime.runTaskMutation(taskIds, operation),
      log,
    })

    try {
      // ─── occurrence consumer registration ─────────────────
      // Runs BEFORE restore()/recoverOnStartup(): both of those commit
      // terminal occurrences of their own, and an occurrence dispatched
      // with no consumer registered stays undispatched (see
      // OccurrenceDispatcher). Registering first lets those land live
      // instead of waiting a restart.
      occurrenceDispatcher.register('task-inspector-activity-timeline', (occ) =>
        taskInspectorActivityRuntime.recordOccurrence(occ)
      )
      const failureLogConsumer = createFailureLogConsumer(log)
      occurrenceDispatcher.register(
        failureLogConsumer.name,
        failureLogConsumer.consume
      )
      const notificationConsumer = createNotificationOccurrenceConsumer({
        center: notificationCenter,
        getTaskName: (id) => taskManager.getById(id)?.name ?? null,
      })
      occurrenceDispatcher.register(
        notificationConsumer.name,
        notificationConsumer.consume
      )

      await sessionManager.restore()
      if (!shellAsyncWork.isAccepting()) return
      await sessionManager.recoverLegacyTaskLost()
      if (!shellAsyncWork.isAccepting()) return

      // Plan B: re-prime MagnetTracker's in-memory cache from the
      // restored db state so polling skips magnet metadata GIDs and
      // quarantine tombstones survive across restart.
      magnetTracker.primeFromDatabase()

      // Startup recovery: replay intent markers before polling/events
      // open so the renderer observes a self-healed state. See design
      // spec §6.6.
      const recoveryService = new TaskRecoveryServiceImpl({
        taskManager: {
          getAll: () => taskManager.getAll(),
          set: (id: string, task: DownloadTask) => taskManager.set(id, task),
          persist: persistTask,
        },
        persistTaskWithOccurrence,
        occurrenceDispatcher,
        db,
        adapter: {
          listActiveAndWaiting: () => adapter.listActiveAndWaiting(),
        },
        fs: defaultRecoveryFs,
        finalizeTask: (taskId) => finalizeTask(taskId, buildFinalizeDeps()),
        activityRecorder: taskActivityService,
        recordTransition: (input: RuntimeTransitionInput) =>
          taskInspectorActivityRuntime.recordTransition(input),
        runTaskMutation: <T>(
          taskIds: readonly string[],
          operation: () => Promise<T>
        ) => taskInspectorActivityRuntime.runTaskMutation(taskIds, operation),
        log,
      })

      const recoveredAnchorOrigins =
        taskInspectorActivityRuntime.captureRecoveredAnchorOrigins(
          taskManager.getAll()
        )
      const report = await recoveryService.recoverOnStartup()
      if (!shellAsyncWork.isAccepting()) return
      await taskInspectorActivityRuntime.recordRecoveredAnchors(
        taskManager.getAll(),
        recoveredAnchorOrigins
      )
      if (!shellAsyncWork.isAccepting()) return
      log.info({ report }, 'startup_recovery_done')
      // Publish the authoritative post-recovery snapshot (mirrors the
      // desktop shell). Recovery rewrites stopped-state rows that polling
      // never observes, and the poll tick is delta-gated — without this
      // one forced flush, a restored-then-repaired task would stay stale
      // for every push consumer until some unrelated change came along.
      publishTaskUpdateNow()
      if (report.warnings.length > 0 || report.errors.length > 0) {
        eventBus.emit(Events.ToastShow, {
          key: 'task.recovery.toast',
          params: { count: report.totalScanned },
        })
      }

      adapter.onBtDownloadComplete((engineTaskId) => {
        runShellAsyncWork('BT finalize', async () => {
          const task = taskManager.getByEngineTaskId(engineTaskId)
          if (!task) return
          if (shouldSkipEngineCompletionFinalize(task)) return
          try {
            await finalizeTask(task.id, buildFinalizeDeps())
          } catch (err) {
            log.error({ err, taskId: task.id }, 'finalizeTask failed (BT)')
          }
        })
      })

      adapter.onDownloadComplete((engineTaskId) => {
        runShellAsyncWork('HTTP finalize', async () => {
          const task = taskManager.getByEngineTaskId(engineTaskId)
          if (!task) return
          if (task.type !== TaskType.Http && task.type !== TaskType.Ftp) {
            return
          }
          if (shouldSkipEngineCompletionFinalize(task)) return
          try {
            await finalizeTask(task.id, buildFinalizeDeps())
          } catch (err) {
            log.error({ err, taskId: task.id }, 'finalizeTask failed (HTTP)')
          }
        })
      })

      sessionManager.startAutoSave(engineSettings.sessionSaveInterval * 1000)

      pollingNotificationUnsubscribers.push(
        rpcClient.onDownloadStart((event) => {
          pollingScheduler.handleNotification('aria2.onDownloadStart', event)
        }),
        rpcClient.onDownloadPause((event) => {
          pollingScheduler.handleNotification('aria2.onDownloadPause', event)
        }),
        rpcClient.onDownloadComplete((event) => {
          pollingScheduler.handleNotification('aria2.onDownloadComplete', event)
        }),
        rpcClient.onDownloadStop((event) => {
          pollingScheduler.handleNotification('aria2.onDownloadStop', event)
        }),
        rpcClient.onDownloadError((event) => {
          pollingScheduler.handleNotification('aria2.onDownloadError', event)
        }),
        rpcClient.onBtDownloadComplete((event) => {
          pollingScheduler.handleNotification(
            'aria2.onBtDownloadComplete',
            event
          )
        })
      )

      // Deliver anything the outbox still holds: rows a prior run persisted
      // but never dispatched, plus everything restore()/recovery just wrote
      // through SessionManager (which has no dispatcher of its own).
      await occurrenceDispatcher.drainAtStartup()

      pollingScheduler.start()
    } catch (err) {
      if (!shellAsyncWork.isAccepting()) return
      log.error({ err }, 'post-engine setup failed')
      throw err
    }

    // Do not expose command/query ingress until restore, transition recovery,
    // and recovered Activity anchors have settled. Otherwise an early request
    // can observe an empty/partial TaskManager or a false TaskNotFound.
    const port = Number(process.env.PORT ?? 8080)
    try {
      await app.listen({ port, host: '0.0.0.0' })
    } catch (err) {
      if (!shellAsyncWork.isAccepting()) return
      throw err
    }
    if (!shellAsyncWork.isAccepting()) {
      try {
        await app.close()
      } catch (err) {
        log.warn({ err }, 'late HTTP listener cleanup failed')
      }
      return
    }
    log.info({ port }, 'server listening')

    // ─── MDXP bridge (Spec 6) ─────────────────────────────────────
    // Agent-facing unary POST /mdxp + SSE GET /mdxp/events, on its OWN port
    // (default loopback:16801), separate from the Fastify web/RPC server above.
    // Non-fatal: a bind failure (e.g. port in use) must not take down the web UI.
    try {
      const removeTaskDeps = {
        taskManager,
        adapter,
        log,
        fileCleanupService,
        torrentMetaStore,
        eventBus,
        db,
        magnetTracker,
        taskPersistence: sessionManager,
        publishTaskUpdate,
        publishTaskUpdateNow,
        deleteParentTasks: (
          taskIds: readonly string[],
          deleteParents: () => void | Promise<void>
        ) =>
          taskInspectorActivityRuntime.deleteParentTasks(
            taskIds,
            deleteParents
          ),
        runTaskMutation: <T>(
          taskIds: readonly string[],
          operation: () => Promise<T>
        ) => taskInspectorActivityRuntime.runTaskMutation(taskIds, operation),
      }
      const createTaskDeps = {
        adapter,
        settingsManager,
        finalNamePicker,
        torrentMetaStore,
        taskManager,
        eventBus,
        publishTaskUpdate,
        activityRecorder: taskActivityService,
        persistTask,
        parentTaskCreated: (
          task: DownloadTask,
          persistParent: () => void | Promise<void>
        ) =>
          taskInspectorActivityRuntime.parentTaskCreated(task, persistParent),
        rollbackTaskCreation: (taskId: string) =>
          sessionManager.runExclusivePersistence(() =>
            taskInspectorActivityRuntime.deleteParentTask(taskId, () => {
              db.deleteTask(taskId)
            })
          ),
        runTaskMutation: <T>(
          taskIds: readonly string[],
          operation: () => Promise<T>
        ) => taskInspectorActivityRuntime.runTaskMutation(taskIds, operation),
        waitForEngineReady: () =>
          supervisor.waitUntilReady(ENGINE_READY_TIMEOUT_MS),
        prepareSaveDir: (requested: string) =>
          downloadPathPolicy.prepareSaveDir(requested),
      }
      const taskActionDeps = {
        taskManager,
        adapter,
        eventBus,
        log,
        persistTask,
        persistTaskWithOccurrence,
        occurrenceDispatcher,
        recordTransition: (input: RuntimeTransitionInput) =>
          taskInspectorActivityRuntime.recordTransition(input),
        runTaskMutation: <T>(
          taskIds: readonly string[],
          operation: () => Promise<T>
        ) => taskInspectorActivityRuntime.runTaskMutation(taskIds, operation),
        publishTaskUpdate,
        publishTaskUpdateNow,
      }
      // Validate the port so a typo in MOTRIX_MDXP_PORT falls back loudly to the
      // default rather than NaN → ERR_SOCKET_BAD_PORT → swallowed by the catch
      // below (silently no bridge on a headless host).
      const rawPort = process.env.MOTRIX_MDXP_PORT
      const parsedPort = rawPort === undefined ? 16801 : Number(rawPort)
      const mdxpPort =
        Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort < 65536
          ? parsedPort
          : 16801
      if (parsedPort !== mdxpPort) {
        log.warn(
          { MOTRIX_MDXP_PORT: rawPort },
          'invalid MOTRIX_MDXP_PORT — falling back to 16801'
        )
      }
      const candidateBridgeRuntime = await bootstrapBridgeForServer({
        userDataDir: platform.userDataDir,
        host: process.env.MOTRIX_MDXP_HOST ?? '127.0.0.1',
        port: mdxpPort,
        motrixVersion: process.env.MOTRIX_APP_VERSION ?? '2.0.0',
        eventBus,
        // The web approval UI is a separate (Fastify) service; the operator points
        // device-code clients at it via MOTRIX_PUBLIC_URL. Unset → no URL printed.
        verificationUri: process.env.MOTRIX_PUBLIC_URL,
        readHandlerDeps: { taskManager, statsAggregator, supervisor },
        writeHandlerDeps: {
          taskManager,
          pauseTask: (taskId) => pauseTaskAction(taskId, taskActionDeps),
          resumeTask: (taskId) => resumeTaskAction(taskId, taskActionDeps),
          removeTask: (taskId, { deleteFiles }) =>
            removeTask(
              taskId,
              { deleteWithFiles: deleteFiles },
              removeTaskDeps
            ),
          createTask: (req) => handleCreateTask(req, createTaskDeps),
          parseTorrentFileCount: async (base64) =>
            (await torrentParser.parse(base64)).files.length,
        },
      })
      if (!shellAsyncWork.isAccepting()) {
        await candidateBridgeRuntime.shutdown()
        return
      }
      bridgeRuntime = candidateBridgeRuntime
      // Make the bridge:* RPC handlers reachable through the already-listening
      // Fastify routes (createApp captured the maps by reference).
      Object.assign(bridgeCommandHandlers, bridgeRuntime.bridgeCommandHandlers)
      Object.assign(bridgeQueryHandlers, bridgeRuntime.bridgeQueryHandlers)
      log.info({ port: bridgeRuntime.port }, 'MDXP bridge listening')
    } catch (err) {
      log.error({ err }, 'MDXP bridge bootstrap failed — continuing without it')
    }
  }

  await runServerStartup(
    () => shellAsyncWork.run(startServer),
    shutdown,
    () => {
      startupExitCode = 1
    }
  )
}

main().catch(async (err) => {
  console.error('fatal', err)
  if (requestActiveServerExit) {
    await requestActiveServerExit(1)
    return
  }
  process.exit(1)
})
