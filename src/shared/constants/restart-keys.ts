import type { EngineSettings, MotrixAppSettings } from '@shared/types/settings'

// Settings consumed while starting the download engine. Runtime defaults
// are applied by its adapter; legacy storage preferences are not runtime controls.
export const ENGINE_RESTART_REQUIRED_KEYS: ReadonlySet<keyof EngineSettings> =
  new Set([
    'rpcPort',
    'rpcSecret',
    'listenPort',
    'dhtListenPort',
    'dhtEnabled',
    'sqlite3DbPath',
    'sessionSaveInterval',
  ])

// Consumed by SettingsManager.update(), which reports requiresAppRestart to
// shell command handlers. Settings forms always save first; shells own any
// follow-up restart notice or action.
//
// Main-window limits are read at window creation. Restarting ensures existing
// windows use the new limits too.
export const APP_RESTART_REQUIRED_KEYS: ReadonlySet<keyof MotrixAppSettings> =
  new Set<keyof MotrixAppSettings>([
    'mainWindowMinWidth',
    'mainWindowMinHeight',
    'hardwareAcceleration',
  ])
