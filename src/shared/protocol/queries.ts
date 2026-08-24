export const Queries = {
  GetDisclaimerState: 'query:getDisclaimerState',
  ListTasks: 'query:listTasks',
  GetTaskDetail: 'query:getTaskDetail',
  GetStats: 'query:getStats',
  GetTaskSpeedHistory: 'query:getTaskSpeedHistory',
  GetTaskInspectorActivity: 'query:getTaskInspectorActivity',
  GetSettings: 'query:getSettings',
  GetUpdateState: 'query:getUpdateState',
  GetSystemProxy: 'query:getSystemProxy',
  ListPlugins: 'query:listPlugins',
  GetPluginManifest: 'query:getPluginManifest',
  // Spec §10 L2875 — formerly `GetPluginSettings`; renamed for terminology
  // alignment with `appSettings.plugins[<id>].config` (spec §7 L2329-2333).
  GetPluginConfig: 'query:getPluginConfig',
  // Spec §I30 — current optional-permission grants (per-plugin) from
  // `_install.json.grants`. Returns `GrantsMap`.
  GetPluginGrants: 'query:getPluginGrants',
  // Bulk variant for PluginsPage / PluginCard audience computation.
  // Returns `Record<pluginId, GrantsMap>` for every discovered community
  // plugin. Cheap (one IPC + N disk reads) compared to per-card queries.
  ListPluginGrants: 'query:listPluginGrants',
  GetPluginCommandGraph: 'query:getPluginCommandGraph',
  GetPluginLogs: 'query:getPluginLogs',
  // Remote plugin registry (dl.motrix.app) — read-side directory queries.
  // Entries come back annotated with a `compatible` host-version flag.
  // Contract: .claude/rules/plugin-registry.md.
  ListRegistryPlugins: 'query:listRegistryPlugins',
  GetRegistryPlugin: 'query:getRegistryPlugin',
  // Spec §10 L2877 — aggregate snapshot of all enabled plugins'
  // contributions (commands, hooks, configurations). Drives the renderer's
  // Integrations tab and the contribution-aware Settings/Logs panels.
  GetContributionIndex: 'query:getContributionIndex',
  // Spec §10 L2878 — pre-install / pre-upgrade compatibility probe for a
  // manifest blob against the running host (engines.motrix range, runtime
  // permissions). Returns `{ok, code?, message?}`.
  CheckPluginCompatibility: 'query:checkPluginCompatibility',
  // Spec §10 L2880 — `{rank, total, role}` of a plugin within the sorted
  // hook chain for "rank #2 of 4" UI display.
  GetPluginHookRank: 'query:getPluginHookRank',
  GetTaskFiles: 'query:getTaskFiles',
  GetTaskPieces: 'query:getTaskPieces',
  GetTaskPeers: 'query:getTaskPeers',
  GetEngineTaskOptions: 'query:getEngineTaskOptions',
  GetEngineStatus: 'query:getEngineStatus',
  GetEngineDiagnostics: 'query:getEngineDiagnostics',
  GetNatStatus: 'query:getNatStatus',
  GetNatDiagnostic: 'query:getNatDiagnostic',
  // Tuning
  GetTuningRecommendation: 'query:getTuningRecommendation',
  // Tracker
  GetTrackerList: 'query:getTrackerList',
  GetTrackerSources: 'query:getTrackerSources',
  GetTaskBtTracker: 'query:getTaskBtTracker',
  // Save directory allowlist (web degradation, electron returns unrestricted)
  ListAllowedSaveDirs: 'query:listAllowedSaveDirs',
  // GeoIP
  GetGeoIPStatus: 'query:getGeoIPStatus',
  // FFmpeg detection
  // Media settings: enriched ffmpeg detection (per-candidate state).
  // Consumed by the Media settings card to render the 4-row status table.
  GetFfmpegDetection: 'query:getFfmpegDetection',
  // Dashboard
  GetSpeedHistory: 'query:getSpeedHistory',
  GetTransferStats: 'query:getTransferStats',
  GetTaskActivity: 'query:getTaskActivity',
  GetSpeedLimitState: 'query:getSpeedLimitState',
  // Notifications
  // ListNotifications returns AppNotification[] (latest 100, createdAt desc).
  ListNotifications: 'query:listNotifications',
  // GetUnreadNotificationCount returns the unread badge count as a number.
  GetUnreadNotificationCount: 'query:getUnreadNotificationCount',
  GetCliToolStatus: 'query:getCliToolStatus',
  // Linux AppImage desktop integration; returns `AppImageIntegrationView`
  // ({ supported: false } outside a packaged Linux AppImage).
  GetAppImageIntegrationStatus: 'query:getAppImageIntegrationStatus',
  GetLinuxDefaultAssociations: 'query:getLinuxDefaultAssociations',
  GetWindowsDefaultAssociations: 'query:getWindowsDefaultAssociations',
  GetApplicationMenu: 'query:getApplicationMenu',
} as const

export type QueryChannel = (typeof Queries)[keyof typeof Queries]
