import type { EngineSettings, MotrixAppSettings } from '@shared/types/settings'

// Keys whose change requires an aria2 process restart. All other
// EngineSettings keys are hot-applied via SpeedLimitController /
// proxy / tracker changeGlobalOption.
export const ENGINE_RESTART_REQUIRED_KEYS: ReadonlySet<keyof EngineSettings> =
  new Set([
    'performanceProfile',
    'rpcPort',
    'rpcSecret',
    'listenPort',
    'dhtListenPort',
    'dhtEnabled',
    'fileAllocation',
    'diskCache',
    'sqlite3Persistence',
    'sqlite3DbPath',
    'sqlite3HistoryLimit',
    'sessionSaveInterval',
  ])

// Consumed by SettingsManager.update(), which reports requiresAppRestart to
// shell command handlers. Settings forms always save first; shells own any
// follow-up restart notice or action.
//
// Currently empty: launchAtStartup is hot-applied via syncAutoLaunch();
// browserBridgeEnabled is hot-applied via BridgeManager.setEnabled().
// Add a key here only if its effect genuinely cannot be applied at runtime.
export const APP_RESTART_REQUIRED_KEYS: ReadonlySet<keyof MotrixAppSettings> =
  new Set<keyof MotrixAppSettings>()
