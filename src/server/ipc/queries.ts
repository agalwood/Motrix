import path from 'node:path'
import type { TaskActivityService } from '@core/activity'
import type { EngineAdapter } from '@core/engine/engine-adapter'
import type { EngineSupervisor } from '@core/engine/engine-supervisor'
import { createGetEngineTaskOptionsHandler } from '@core/engine/get-engine-task-options'
import { getTuningRecommendation } from '@core/engine/get-tuning-recommendation'
import type { GeoIPManager } from '@core/geoip/geo-ip-manager'
import { createGetGeoIPStatusHandler } from '@core/geoip/get-geo-ip-status'
import type { NotificationCenter } from '@core/notifications/notification-center'
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
import { parseProxyEnvironment } from '@core/proxy/system-proxy'
import type { MotrixDatabase } from '@core/session/motrix-database'
import type { SettingsManager } from '@core/settings/settings-manager'
import type { SpeedLimitController } from '@core/speed-limit/speed-limit-controller'
import type {
  SpeedHistoryStore,
  StatsAggregator,
  TaskSpeedHistoryStore,
  TransferStatsRuntime,
} from '@core/stats'
import { createGetTaskFilesHandler } from '@core/task/get-task-files'
import { createGetTaskPeersHandler } from '@core/task/get-task-peers'
import { createGetTaskPiecesHandler } from '@core/task/get-task-pieces'
import { slimTasksForBroadcast } from '@core/task/slim-task-for-broadcast'
import type { TaskManager } from '@core/task/task-manager'
import type { TrackerManager } from '@core/tracker'
import type { QueryHandlerMap } from '@shared/protocol/handler-types'
import { Queries } from '@shared/protocol/queries'
import type { AppUpdateState } from '@shared/types/app-update'
import type { AppImageIntegrationView } from '@shared/types/appimage-integration'
import {
  CliInstallCapability,
  CliPackageManager,
  CliToolPhase,
  CliToolReason,
  type CliToolStatus,
} from '@shared/types/cli-tool'
import type { GetTransferStatsParams } from '@shared/types/stats'
import type { GetTaskActivityParams } from '@shared/types/task-activity'
import type { ServerDownloadPathPolicy } from '../download-path-policy'
import { makeServerFfmpegDetect } from '../plugin/ffmpeg-detect-server'

const UNSUPPORTED_WEB_CLI_STATUS: CliToolStatus = {
  phase: CliToolPhase.ManualOnly,
  capability: CliInstallCapability.ManualOnly,
  installCommand: 'npm install -g @motrix/cli@latest',
  packageManager: CliPackageManager.Unknown,
  managerOptions: [
    {
      manager: CliPackageManager.Npm,
      installCommand: 'npm install -g @motrix/cli@latest',
      available: false,
    },
    {
      manager: CliPackageManager.Pnpm,
      installCommand: 'pnpm add -g @motrix/cli@latest',
      available: false,
    },
    {
      manager: CliPackageManager.Yarn,
      installCommand: 'yarn global add @motrix/cli@latest',
      available: false,
    },
    {
      manager: CliPackageManager.Bun,
      installCommand: 'bun add -g @motrix/cli@latest',
      available: false,
    },
    {
      manager: CliPackageManager.Volta,
      installCommand: 'volta install @motrix/cli@latest',
      available: false,
    },
  ],
  version: null,
  executablePath: null,
  nodeVersion: null,
  reason: CliToolReason.UnsupportedWeb,
  detail: null,
}

const UNSUPPORTED_APPIMAGE_INTEGRATION: AppImageIntegrationView = {
  supported: false,
}

export interface ServerQueryContext {
  taskManager: TaskManager
  statsAggregator: StatsAggregator
  speedHistoryStore: SpeedHistoryStore
  transferStats: TransferStatsRuntime
  taskActivityService: TaskActivityService
  taskSpeedHistoryStore: TaskSpeedHistoryStore
  taskInspectorActivityRuntime: {
    snapshot(params: unknown): unknown
  }
  supervisor: EngineSupervisor
  settingsManager: SettingsManager
  trackerManager: TrackerManager
  engineAdapter: EngineAdapter
  motrixDatabase: MotrixDatabase
  geoipManager: Pick<GeoIPManager, 'getStatus' | 'isEnabled' | 'lookupCountry'>
  notificationCenter: NotificationCenter
  pluginRegistry: PluginRegistry
  capabilityHost: CapabilityHost
  pluginGrants: GrantsManager
  registryClient: RegistryClient
  pluginsDir: string
  hostVersion: string
  userDataDir: string
  speedLimitController: SpeedLimitController
  downloadPathPolicy: ServerDownloadPathPolicy
  environment: NodeJS.ProcessEnv
}

export function buildServerQueryHandlers(
  ctx: ServerQueryContext
): QueryHandlerMap {
  const {
    taskManager,
    statsAggregator,
    speedHistoryStore,
    transferStats,
    taskActivityService,
    taskSpeedHistoryStore,
    taskInspectorActivityRuntime,
    supervisor,
    settingsManager,
    trackerManager,
    engineAdapter,
    motrixDatabase,
    geoipManager,
    notificationCenter,
    pluginRegistry,
    capabilityHost,
    pluginGrants,
    registryClient,
    pluginsDir,
    hostVersion,
    userDataDir,
    speedLimitController,
    downloadPathPolicy,
    environment,
  } = ctx

  const detectFfmpeg = makeServerFfmpegDetect({
    settingsManager,
    userDataDir,
  })

  return {
    [Queries.GetDisclaimerState]: async () => ({
      language: settingsManager.getApp().language,
    }),

    [Queries.GetCliToolStatus]: async () => UNSUPPORTED_WEB_CLI_STATUS,

    // Same slim projection as the TaskUpdated broadcast so hydration and
    // pushed snapshots agree; GetTaskDetail below stays full-fat.
    [Queries.ListTasks]: async () =>
      slimTasksForBroadcast(taskManager.getAll()),

    // Parity with the Electron shell (src/main/ipc/queries.ts): a single-task
    // read keyed by public id, null when absent (never undefined).
    [Queries.GetTaskDetail]: async (taskId: string) =>
      taskManager.getById(taskId) ?? null,

    [Queries.GetTaskFiles]: createGetTaskFilesHandler({
      db: motrixDatabase,
      taskManager,
      engine: engineAdapter,
    }),

    [Queries.GetEngineTaskOptions]: createGetEngineTaskOptionsHandler({
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

    [Queries.GetStats]: async () => statsAggregator.getStats(),

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

    [Queries.GetTaskInspectorActivity]: async (params: unknown) =>
      taskInspectorActivityRuntime.snapshot(params),

    [Queries.GetEngineStatus]: async () => supervisor.getStatus(),

    [Queries.GetEngineDiagnostics]: async () => supervisor.diagnose(),

    [Queries.GetTuningRecommendation]: getTuningRecommendation,

    [Queries.GetNatStatus]: async () => null,

    [Queries.GetNatDiagnostic]: async () => null,

    [Queries.GetSettings]: async () => settingsManager.get(),

    [Queries.GetGeoIPStatus]: createGetGeoIPStatusHandler({ geoipManager }),

    [Queries.GetSystemProxy]: async () => parseProxyEnvironment(environment),

    [Queries.GetUpdateState]: async (): Promise<AppUpdateState> => ({
      phase: 'unsupported',
      currentVersion: hostVersion,
    }),

    [Queries.GetAppImageIntegrationStatus]: async () =>
      UNSUPPORTED_APPIMAGE_INTEGRATION,

    [Queries.GetLinuxDefaultAssociations]: async () => ({
      supported: false,
      packageKind: null,
      registered: false,
      canSetTorrentDefault: false,
      torrent: null,
      magnet: null,
    }),

    [Queries.GetWindowsDefaultAssociations]: async () => ({
      supported: false,
      registered: false,
      scope: null,
      torrent: false,
      magnet: false,
    }),

    [Queries.GetTrackerList]: async () => trackerManager.getCuratedList(),

    [Queries.GetTrackerSources]: async () =>
      settingsManager.get().tracker.sources,

    [Queries.ListAllowedSaveDirs]: async () => {
      const paths = downloadPathPolicy.allowedSaveDirs.map((path) => ({ path }))
      return {
        paths,
        defaultPath: settingsManager.getApp().defaultSaveDir,
        allowCustom: paths.length === 0,
      }
    },

    [Queries.GetTaskBtTracker]: async ({ engineGid }: { engineGid: string }) =>
      engineAdapter.getTaskBtTracker(engineGid),

    [Queries.GetFfmpegDetection]: async () => detectFfmpeg(),

    [Queries.ListPlugins]: async () => pluginRegistry.list(),

    // Parity with the Electron shell: remote-registry directory reads.
    [Queries.ListRegistryPlugins]: async () => registryClient.list(hostVersion),

    [Queries.GetRegistryPlugin]: async (id: string) =>
      registryClient.get(id, hostVersion),

    [Queries.GetPluginManifest]: async (id: string) =>
      pluginRegistry.get(id)?.manifest ?? null,

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

    [Queries.GetSpeedLimitState]: async () => speedLimitController.getState(),

    [Queries.ListNotifications]: async () => notificationCenter.list(),

    [Queries.GetUnreadNotificationCount]: async () =>
      notificationCenter.unreadCount(),

    // NAT, tuning, and history queries are intentionally omitted in server
    // mode — those subsystems are Electron-only or not wired here yet.
  }
}
