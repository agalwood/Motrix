import type { EngineSettings, MotrixAppSettings } from '@shared/types/settings'

// Keys whose change requires an aria2 process restart. All other
// EngineSettings keys are hot-applied via SpeedLimitController /
// proxy / tracker changeGlobalOption.
export const ENGINE_RESTART_REQUIRED_KEYS: ReadonlySet<keyof EngineSettings> =
  new Set([
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
  ])

// Consumed by:
//   - renderer's patchHasRestartKeys() — shows RestartConfirmDialog before saving
//   - SettingsManager.update() — sets requiresAppRestart in UpdateResult
//   - Commands.UpdateSettings handler — calls app.relaunch() + app.exit(0)
//
// Currently empty: launchAtStartup is hot-applied via syncAutoLaunch();
// browserBridgeEnabled is hot-applied via BridgeManager.setEnabled().
// Add a key here only if its effect genuinely cannot be applied at runtime.
export const APP_RESTART_REQUIRED_KEYS: ReadonlySet<keyof MotrixAppSettings> =
  new Set<keyof MotrixAppSettings>()
