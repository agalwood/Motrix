import path from 'node:path'
import type { TaskActivityService } from '@core/activity'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import type { EngineSupervisor } from '@core/engine/engine-supervisor'
import { getTuningRecommendation } from '@core/engine/get-tuning-recommendation'
import type { GeoIPManager } from '@core/geoip/geo-ip-manager'
import { createGetGeoIPStatusHandler } from '@core/geoip/get-geo-ip-status'
import type { CapabilityHost } from '@core/plugin/capabilities/interface'
import { readCommandGraph } from '@core/plugin/commands/command-graph'
import type { GrantsManager } from '@core/plugin/grants/grants-manager'
import type { PluginRegistry } from '@core/plugin/plugin-registry'
import {
  buildContributionIndex,
  checkPluginCompatibility,
  computePluginHookRank,
  readPluginConfig,
} from '@core/plugin/queries'
import type { RegistryClient } from '@core/plugin/registry/registry-client'
import { parseElectronProxyChain } from '@core/proxy/system-proxy'
import type { MotrixDatabase } from '@core/session/motrix-database'
import type { SettingsManager } from '@core/settings/settings-manager'
import type { SpeedLimitController } from '@core/speed-limit/speed-limit-controller'
import type {
  SpeedHistoryStore,
  StatsAggregator,
  TaskSpeedHistoryStore,
  TransferStatsRuntime,
} from '@core/stats'
import { createGetTaskPeersHandler } from '@core/task/get-task-peers'
import { createGetTaskPiecesHandler } from '@core/task/get-task-pieces'
import { slimTasksForBroadcast } from '@core/task/slim-task-for-broadcast'
import type { TaskManager } from '@core/task/task-manager'
import type { TrackerManager } from '@core/tracker'
import type { NatManager } from '@motrix/nat'
import {
  assertTaskInspectorActivityArguments,
  makeProtocolFailure,
  makeProtocolSuccess,
} from '@shared/protocol/errors'
import type { QueryHandlerMap } from '@shared/protocol/handler-types'
import { Queries } from '@shared/protocol/queries'
import { parseTaskInspectorActivitySnapshot } from '@shared/schemas/task-inspector-activity'
import type { GetTransferStatsParams } from '@shared/types/stats'
import type { GetTaskActivityParams } from '@shared/types/task-activity'
import { ipcMain, session } from 'electron'
import type { CliToolService } from '../cli/cli-tool-service'
import type { UpdateManager } from '../core/update-manager'
import { getAppImageIntegrationView } from '../platform/appimage-integration-host'
import { getLinuxDefaultAssociations } from '../platform/linux-default-apps'
import { getWindowsDefaultAssociations } from '../platform/windows-default-apps'
import { makeElectronFfmpegDetect } from '../plugin/ffmpeg-detect-electron'
import { createGetEngineTaskOptionsHandler } from './queries/get-engine-task-options'
import { createGetTaskBtTrackerHandler } from './queries/get-task-bt-tracker'
import { createGetTaskFilesHandler } from './queries/get-task-files'
import { registerTrustedIpcHandler } from './trusted-ipc'

const SYSTEM_PROXY_PROBE_PARTITION = 'motrix-system-proxy-probe'
const SYSTEM_PROXY_PROBE_URL = 'https://example.com'

export interface QueryContext {
  cliToolService: Pick<CliToolService, 'getStatus'>
  taskManager: TaskManager
  statsAggregator: StatsAggregator
  speedHistoryStore: SpeedHistoryStore
  transferStats: TransferStatsRuntime
  taskActivityService: TaskActivityService
  taskSpeedHistoryStore: TaskSpeedHistoryStore
  taskInspectorActivityRuntime: {
    snapshot(params: unknown): unknown
  }
  waitForTasksReady?: () => Promise<void>
  trackAsyncWork?: <T>(operation: () => Promise<T>) => Promise<T>
  supervisor: EngineSupervisor
  settingsManager: SettingsManager
  natManager: NatManager
  trackerManager: TrackerManager
  engineAdapter: EngineAdapter
  motrixDatabase: MotrixDatabase
  geoipManager: GeoIPManager
  pluginRegistry: PluginRegistry
  registryClient: RegistryClient
  pluginGrants: GrantsManager
  pluginsDir: string
  capabilityHost: CapabilityHost
  hostVersion: string
  userDataDir: string
  speedLimitController: SpeedLimitController
  updateManager: UpdateManager
}

export function buildQueryHandlers(ctx: QueryContext): QueryHandlerMap {
  const {
    cliToolService,
    taskManager,
    statsAggregator,
    speedHistoryStore,
    transferStats,
    taskActivityService,
    taskSpeedHistoryStore,
    taskInspectorActivityRuntime,
    waitForTasksReady,
    supervisor,
    settingsManager,
    natManager,
    trackerManager,
    engineAdapter,
    motrixDatabase,
    geoipManager,
    pluginRegistry,
    registryClient,
    pluginGrants,
    pluginsDir,
    capabilityHost,
    hostVersion,
    userDataDir,
    speedLimitController,
    updateManager,
  } = ctx

  const detectFfmpeg = makeElectronFfmpegDetect({
    settingsManager,
    userDataDir,
  })

  return {
    [Queries.GetCliToolStatus]: async () => cliToolService.getStatus(),

    [Queries.ListTasks]: async () => {
      await waitForTasksReady?.()
      // Same slim projection as the TaskUpdated broadcast so hydration and
      // pushed snapshots agree; GetTaskDetail below stays full-fat.
      return slimTasksForBroadcast(taskManager.getAll())
    },

    [Queries.GetTaskDetail]: async (taskId: string) => {
      await waitForTasksReady?.()
      return taskManager.getById(taskId) ?? null
    },

    [Queries.GetStats]: async () => {
      return statsAggregator.getStats()
    },

    [Queries.GetSpeedHistory]: async (params?: { limit?: number }) =>
      speedHistoryStore.snapshot(params?.limit),

    [Queries.GetTransferStats]: async (params: GetTransferStatsParams) =>
      transferStats.snapshot(params),

    [Queries.GetTaskActivity]: async (params: GetTaskActivityParams) =>
      taskActivityService.snapshot(params),

    [Queries.GetTaskSpeedHistory]: async (params: {
      taskId: string
      limit?: number
    }) => taskSpeedHistoryStore.snapshot(params.taskId, params.limit),

    [Queries.GetTaskInspectorActivity]: async (params: unknown) => {
      await waitForTasksReady?.()
      return taskInspectorActivityRuntime.snapshot(params)
    },

    [Queries.GetSettings]: async () => {
      return settingsManager.get()
    },

    [Queries.GetUpdateState]: async () => updateManager.getState(),

    [Queries.GetSystemProxy]: async () => {
      // The default session carries Motrix's explicit app-update route, which
      // can be `direct` even while the OS has a proxy configured. Probe with a
      // separate in-memory session so importing system settings neither reads
      // nor mutates the app's active route.
      const systemProxySession = session.fromPartition(
        SYSTEM_PROXY_PROBE_PARTITION,
        { cache: false }
      )
      await systemProxySession.setProxy({ mode: 'system' })
      await systemProxySession.forceReloadProxyConfig()
      const chain = await systemProxySession.resolveProxy(
        SYSTEM_PROXY_PROBE_URL
      )
      return parseElectronProxyChain(chain)
    },

    [Queries.GetAppImageIntegrationStatus]: async () =>
      getAppImageIntegrationView({
        getMagnetEnabled: () => settingsManager.getApp().protocols.magnet,
      }),

    [Queries.GetLinuxDefaultAssociations]: async () =>
      getLinuxDefaultAssociations(),

    [Queries.GetWindowsDefaultAssociations]: async () =>
      getWindowsDefaultAssociations(),

    [Queries.GetEngineStatus]: async () => {
      return supervisor.getStatus()
    },

    [Queries.GetEngineDiagnostics]: async () => supervisor.diagnose(),

    [Queries.GetSpeedLimitState]: async () => speedLimitController.getState(),

    [Queries.GetTaskFiles]: createGetTaskFilesHandler({
      db: motrixDatabase,
      taskManager,
      engine: engineAdapter,
    }),

    [Queries.GetTaskPieces]: createGetTaskPiecesHandler({
      engineAdapter,
      taskManager,
    }),

    [Queries.GetTaskPeers]: createGetTaskPeersHandler({
      engineAdapter,
      taskManager,
      geoipManager,
    }),

    [Queries.GetNatStatus]: async () => natManager.getStatus(),

    [Queries.GetNatDiagnostic]: async () =>
      natManager.getStatus().lastDiagnostic,

    [Queries.GetTuningRecommendation]: getTuningRecommendation,

    [Queries.GetTrackerList]: async () => {
      return trackerManager.getCuratedList()
    },

    [Queries.GetTrackerSources]: async () => {
      return settingsManager.get().tracker.sources
    },

    [Queries.ListAllowedSaveDirs]: async () => ({
      paths: [],
      defaultPath: settingsManager.getApp().defaultSaveDir,
      allowCustom: true,
    }),

    [Queries.GetGeoIPStatus]: createGetGeoIPStatusHandler({ geoipManager }),

    [Queries.GetFfmpegDetection]: async () => detectFfmpeg(),

    [Queries.GetTaskBtTracker]: createGetTaskBtTrackerHandler({
      engineAdapter,
    }),

    [Queries.GetEngineTaskOptions]: createGetEngineTaskOptionsHandler({
      engine: engineAdapter,
    }),

    [Queries.ListPlugins]: async () => pluginRegistry.list(),

    [Queries.GetPluginManifest]: async (id: string) =>
      pluginRegistry.get(id)?.manifest ?? null,

    [Queries.ListRegistryPlugins]: async () => registryClient.list(hostVersion),

    [Queries.GetRegistryPlugin]: async (id: string) =>
      registryClient.get(id, hostVersion),

    [Queries.GetPluginCommandGraph]: async () =>
      readCommandGraph(
        path.join(pluginsDir, '_audit', 'command-invokes.ndjson')
      ),

    [Queries.GetPluginLogs]: async (params: {
      pluginId: string
      limit?: number
    }) => capabilityHost.getTail(params.pluginId, params.limit ?? 100),

    [Queries.GetPluginConfig]: async (pluginId: string) =>
      readPluginConfig(settingsManager.get(), pluginId),

    [Queries.GetPluginGrants]: async (pluginId: string) =>
      pluginGrants.getGrants(pluginId),

    [Queries.ListPluginGrants]: async () => pluginGrants.listAllGrants(),

    [Queries.GetContributionIndex]: async () =>
      buildContributionIndex(pluginRegistry.entries()),

    [Queries.CheckPluginCompatibility]: async (params: {
      manifest: Parameters<typeof checkPluginCompatibility>[0]
      origin?: 'community' | 'builtin'
    }) =>
      checkPluginCompatibility(params.manifest, hostVersion, {
        origin: params.origin,
      }),

    [Queries.GetPluginHookRank]: async (params: {
      pluginId: string
      hook: string
    }) =>
      computePluginHookRank(
        pluginRegistry.entries(),
        params.pluginId,
        params.hook
      ),
  }
}

export function registerQueryHandlers(ctx: QueryContext): () => void {
  const handlers = buildQueryHandlers(ctx)
  const channels = Object.keys(handlers)

  for (const [channel, handler] of Object.entries(handlers)) {
    registerTrustedIpcHandler(channel, async (_event, ...args) => {
      const invoke = () =>
        ctx.trackAsyncWork
          ? ctx.trackAsyncWork(async () => handler(...args))
          : handler(...args)
      if (channel !== Queries.GetTaskInspectorActivity) {
        return invoke()
      }
      try {
        assertTaskInspectorActivityArguments(args)
        const value = await invoke()
        const snapshot = parseTaskInspectorActivitySnapshot(value)
        if (!snapshot) {
          throw new Error('Invalid Task Inspector Activity snapshot')
        }
        return makeProtocolSuccess(snapshot)
      } catch (error) {
        return makeProtocolFailure(error)
      }
    })
  }
  return () => {
    for (const channel of channels) {
      ipcMain.removeHandler(channel)
    }
  }
}
