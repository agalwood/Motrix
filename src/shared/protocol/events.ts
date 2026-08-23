import type { SupportedLocale } from '@shared/constants/locales'

export interface LocaleChangedPayload {
  language: SupportedLocale
}

export interface WindowMaximizedChangedPayload {
  maximized: boolean
}

export const Events = {
  TaskUpdated: 'event:taskUpdated',
  TaskFilesUpdated: 'event:taskFilesUpdated',
  TaskActivityUpdated: 'event:taskActivityUpdated',
  TaskInspectorActivityUpdated: 'event:taskInspectorActivityUpdated',
  StatsUpdated: 'event:statsUpdated',
  EngineDisconnected: 'event:engineDisconnected',
  EngineRecovered: 'event:engineRecovered',
  EngineReconnecting: 'event:engineReconnecting',
  PluginError: 'event:pluginError',
  PluginTimeout: 'event:pluginTimeout',
  PluginStatusChanged: 'event:pluginStatusChanged',
  PluginInstalled: 'event:pluginInstalled',
  PluginUninstalled: 'event:pluginUninstalled',
  PluginInstallConsentRequested: 'event:pluginInstallConsentRequested',
  PluginInstallProgress: 'event:pluginInstallProgress',
  EngineStateChanged: 'event:engineStateChanged',
  EngineActiveChanged: 'event:engineActiveChanged',
  EngineRestartRequired: 'event:engineRestartRequired',
  PortConflict: 'event:portConflict',
  ProtocolUrl: 'event:protocolUrl',
  ProtocolTorrentFile: 'event:protocolTorrentFile',
  TorrentQueueSizeChanged: 'event:torrentQueueSizeChanged',
  AppCrash: 'event:appCrash',
  AppError: 'event:appError',
  SettingsChanged: 'event:settingsChanged',
  LocaleChanged: 'event:localeChanged',
  SpeedLimitChanged: 'event:speedLimitChanged',
  // Torrent
  MagnetFileSelection: 'event:magnetFileSelection',
  // SetAddTaskMode payload is now `AddTaskUrlParams` — see
  // @shared/schemas/add-task.ts setAddTaskModeEventPayloadSchema.
  // The legacy `{ mode: 'links' | 'torrent' }` shape is a valid subset.
  SetAddTaskMode: 'event:setAddTaskMode',
  // NAT
  NatStateChanged: 'event:natStateChanged',
  NatMappingUpdated: 'event:natMappingUpdated',
  NatDiagnosticCompleted: 'event:natDiagnosticCompleted',
  NatGatewayChanged: 'event:natGatewayChanged',
  NatError: 'event:natError',
  // Tuning
  TuningUpdated: 'event:tuningUpdated',
  // Tracker
  TrackerListUpdated: 'event:trackerListUpdated',
  TrackerSyncFailed: 'event:trackerSyncFailed',
  // Navigation
  NavigateTo: 'event:navigateTo',
  // Toasts (renderer shows a toast)
  ToastShow: 'event:toastShow',
  // App auto-update
  UpdateStateChanged: 'event:updateStateChanged',
  UpdateCheckStarted: 'event:updateCheckStarted',
  UpdateAvailable: 'event:updateAvailable',
  UpdateNotAvailable: 'event:updateNotAvailable',
  UpdateDownloadProgress: 'event:updateDownloadProgress',
  UpdateDownloaded: 'event:updateDownloaded',
  UpdateCancelled: 'event:updateCancelled',
  UpdateError: 'event:updateError',
  // GeoIP database lifecycle
  GeoIPUpdateProgress: 'event:geoipUpdateProgress',
  GeoIPStatusChanged: 'event:geoipStatusChanged',
  // Plugin config
  PluginConfigChanged: 'event:pluginConfigChanged',
  // Spec §I30 — optional-permission grants mutated; payload is `{pluginId}`.
  // Renderer refetches GetPluginGrants; main deactivates the plugin so the
  // next activation picks up new effective permissions.
  PluginGrantsChanged: 'event:pluginGrantsChanged',
  // Plugin lifecycle cap
  PluginEvicted: 'event:pluginEvicted',
  PluginActivationCapExceeded: 'event:pluginActivationCapExceeded',
  // Plugin log stream — opt-in per-plugin subscription via
  // `${Events.PluginLog}:<pluginId>` channel. Renderer subscribes to the
  // suffixed channel; main broadcasts each LogEntry from
  // `capabilityHost.subscribeLog`.
  PluginLog: 'event:pluginLog',
  // Spec §10 L2889 — emitted whenever the aggregated contribution index
  // changes (plugin enable/disable/install/uninstall). Renderer refetches
  // GetContributionIndex on receipt. No payload — refetch is the contract.
  ContributionIndexChanged: 'event:contributionIndexChanged',
  // Spec §10 L2890 — opt-in monitoring channel for cross-plugin command
  // invocations. Aligns with audit NDJSON content (caller, callee,
  // commandId, durMs, ok) without duplicating retention. Useful for the
  // Integrations tab live view.
  PluginCommandInvoked: 'event:pluginCommandInvoked',
  // Notifications
  // Payload: AppNotification.
  NotificationAdded: 'event:notificationAdded',
  // No payload; consumers refetch the unread badge count and panel list.
  NotificationsChanged: 'event:notificationsChanged',
  // Payload: EngineFailurePayload (Task 13). NOT included in
  // ForwardableEvents — internal main-process producer signal only.
  EngineFailureOccurred: 'event:engineFailureOccurred',
  // Payload: EngineCompatibilityWarningPayload. Internal shell signal; the
  // resulting durable NotificationAdded event is what reaches renderers.
  EngineCompatibilityWarning: 'event:engineCompatibilityWarning',
  ApplicationMenuChanged: 'event:applicationMenuChanged',
  // Renderer-local shell state. Electron sends this directly to the owning
  // BrowserWindow instead of broadcasting it through the core event bus.
  WindowMaximizedChanged: 'event:windowMaximizedChanged',
} as const

export type EventChannel = (typeof Events)[keyof typeof Events]
