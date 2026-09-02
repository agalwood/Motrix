export const Commands = {
  PauseTask: 'command:pauseTask',
  ResumeTask: 'command:resumeTask',
  RemoveTask: 'command:removeTask',
  ReAddTask: 'command:reAddTask',
  StopSeedingTask: 'command:stopSeedingTask',
  // Plural task commands (option C of the emit-coalescing design): one
  // renderer request per multi-select action instead of one per task.
  // Renderer-IPC only — deliberately NOT MDXP methods; extensions and the
  // CLI keep driving the singular task/* wire methods.
  PauseTasks: 'command:pauseTasks',
  ResumeTasks: 'command:resumeTasks',
  RemoveTasks: 'command:removeTasks',
  ReAddTasks: 'command:reAddTasks',
  // Generic user Retry. Shell handlers route sidecar-backed torrents to
  // re-add and unresolved magnets to a fresh metadata-resolution attempt.
  RetryTasks: 'command:retryTasks',
  StopSeedingTasks: 'command:stopSeedingTasks',
  SetSelectedFiles: 'command:setSelectedFiles',
  UpdateSettings: 'command:updateSettings',
  AcceptDisclaimer: 'command:acceptDisclaimer',
  DeclineDisclaimer: 'command:declineDisclaimer',
  SetDisclaimerLanguage: 'command:setDisclaimerLanguage',
  EnablePlugin: 'command:enablePlugin',
  DisablePlugin: 'command:disablePlugin',
  UpdatePluginOrder: 'command:updatePluginOrder',
  UpdatePluginConfig: 'command:updatePluginConfig',
  InstallPlugin: 'command:installPlugin',
  ConfirmPluginInstall: 'command:confirmPluginInstall',
  CancelPluginInstall: 'command:cancelPluginInstall',
  UninstallPlugin: 'command:uninstallPlugin',
  // Spec §I30 — user-revocable optional permission grants. Patch is a
  // partial `GrantsMap`; unknown / required-permission keys are rejected
  // with `plugin.grants.unknown_permission`.
  UpdatePluginGrants: 'command:updatePluginGrants',
  ClearPluginLogs: 'command:clearPluginLogs',
  SetPluginLogVerbose: 'command:setPluginLogVerbose',
  // Spec §10 L2870 — auto-update check entry point. Renderer-triggered;
  // host scans configured remotes for newer versions of installed plugins
  // and returns a list of `{pluginId, currentVersion, latestVersion}`.
  CheckPluginUpdates: 'command:checkPluginUpdates',
  // Builtin hot-update channel (2026-07-18 design §5). Signed overlay
  // installs — never routed through InstallPlugin/plugin-installer.
  InstallBuiltinUpdate: 'command:installBuiltinUpdate',
  ConfirmBuiltinUpdate: 'command:confirmBuiltinUpdate',
  CancelBuiltinUpdate: 'command:cancelBuiltinUpdate',
  RevertBuiltinToBundled: 'command:revertBuiltinToBundled',
  RestartEngine: 'command:restartEngine',
  RecoverEngine: 'command:recoverEngine',
  ConfirmPortSwitch: 'command:confirmPortSwitch',
  NextTorrent: 'command:nextTorrent',
  DownloadAllTorrents: 'command:downloadAllTorrents',
  CloseCurrentWindow: 'command:closeCurrentWindow',
  MinimizeCurrentWindow: 'command:minimizeCurrentWindow',
  ToggleMaximizeCurrentWindow: 'command:toggleMaximizeCurrentWindow',
  ShowMainWindow: 'command:showMainWindow',
  ShowAddTaskWindow: 'command:showAddTaskWindow',
  // Torrent
  ParseTorrent: 'command:parseTorrent',
  AddTorrentTask: 'command:addTorrentTask',
  AddMagnetTask: 'command:addMagnetTask',
  // Re-open the file-selection dialog for a magnet that already resolved its
  // metadata (status=metadata_ready) but whose dialog was dismissed.
  ReopenMagnetFileSelection: 'command:reopenMagnetFileSelection',
  HandleDroppedTorrent: 'command:handleDroppedTorrent',
  // NAT
  EnableNat: 'command:enableNat',
  DisableNat: 'command:disableNat',
  RunNatDiagnostic: 'command:runNatDiagnostic',
  ForceRemapNat: 'command:forceRemapNat',
  ExportNatBundle: 'command:exportNatBundle',
  // App auto-update
  CheckForUpdates: 'command:checkForUpdates',
  DownloadUpdate: 'command:downloadUpdate',
  InstallUpdate: 'command:installUpdate',
  // Tracker
  SyncTrackers: 'command:syncTrackers',
  SyncTaskBtTracker: 'command:syncTaskBtTracker',
  SetTaskBtTracker: 'command:setTaskBtTracker',
  // Window
  PickSaveDir: 'command:pickSaveDir',
  ResizeWindow: 'command:resizeWindow',
  OpenExternal: 'command:openExternal',
  RequestDefaultTorrentHandler: 'command:requestDefaultTorrentHandler',
  // Linux AppImage desktop integration (settings-driven enable/remove).
  // Both return the refreshed `AppImageIntegrationView`.
  EnableAppImageIntegration: 'command:enableAppImageIntegration',
  RemoveAppImageIntegration: 'command:removeAppImageIntegration',
  RevealInFolder: 'command:revealInFolder',
  // Menu
  UpdateMenuContext: 'command:updateMenuContext',
  ExecuteApplicationMenuItem: 'command:executeApplicationMenuItem',
  // Task creation (engine-neutral)
  CreateTask: 'command:createTask',
  // GeoIP
  UpdateGeoIPDatabase: 'command:updateGeoIPDatabase',
  // Notifications
  // MarkNotificationRead takes (id: string).
  MarkNotificationRead: 'command:markNotificationRead',
  MarkAllNotificationsRead: 'command:markAllNotificationsRead',
  // DeleteNotification takes (id: string).
  DeleteNotification: 'command:deleteNotification',
  ClearNotifications: 'command:clearNotifications',
  InstallCliTool: 'command:installCliTool',
} as const

export type CommandChannel = (typeof Commands)[keyof typeof Commands]
