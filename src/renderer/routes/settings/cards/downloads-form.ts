import { DEFAULT_ENGINE_SETTINGS } from '@shared/schemas'
import { DEFAULT_SPEED_LIMIT_SETTINGS } from '@shared/schemas/speed-limit'
import type { EngineSettings, SpeedLimitSettings } from '@shared/types/settings'

// ─── Form shape ────────────────────────────────────────────────────────────────
// The form combines the engine settings subset with the full speedLimit
// namespace. On submit, pickDirty recurses the dirty-fields tree and returns
// only changed keys at every level, so { engine: {...}, speedLimit: {...} } is
// built correctly. UpdateSettings deep-merges each top-level namespace, so a
// partial speedLimit patch (only the changed sub-fields) is safe.

export type EngineFields = Pick<
  EngineSettings,
  | 'performanceProfile'
  | 'maxConcurrentDownloads'
  | 'maxConnectionPerServer'
  | 'split'
  | 'minSplitSize'
  | 'userAgent'
  | 'connectTimeout'
  | 'socketTimeout'
  | 'maxTries'
  | 'retryWait'
  | 'lowestSpeedLimit'
  | 'fileAllocation'
  | 'remoteTime'
  | 'diskCache'
  | 'sessionSaveInterval'
  | 'magnetResolveTimeout'
>

export interface DownloadsFields {
  engine: EngineFields
  speedLimit: SpeedLimitSettings
}

export const KB = 1024
export const MB = 1024 * 1024
// 1 Mbps (megabit per second) = 1_000_000 bits/sec = 125_000 bytes/sec
// Telecom convention: 1 Mbps = 125_000 bytes/sec (not 1024*1024/8).
export const MBPS = 125_000

// Source of truth: src/shared/schemas/engine-settings.ts (DEFAULT_ENGINE_SETTINGS).
// Defaults are sourced from the schema; the renderer mirrors the subset of
// fields it edits. Keep this Pick<> in sync if the schema fields change.
export const ENGINE_DEFAULTS: EngineFields = {
  performanceProfile: DEFAULT_ENGINE_SETTINGS.performanceProfile,
  maxConcurrentDownloads: DEFAULT_ENGINE_SETTINGS.maxConcurrentDownloads,
  maxConnectionPerServer: DEFAULT_ENGINE_SETTINGS.maxConnectionPerServer,
  split: DEFAULT_ENGINE_SETTINGS.split,
  minSplitSize: DEFAULT_ENGINE_SETTINGS.minSplitSize,
  userAgent: DEFAULT_ENGINE_SETTINGS.userAgent,
  connectTimeout: DEFAULT_ENGINE_SETTINGS.connectTimeout,
  socketTimeout: DEFAULT_ENGINE_SETTINGS.socketTimeout,
  maxTries: DEFAULT_ENGINE_SETTINGS.maxTries,
  retryWait: DEFAULT_ENGINE_SETTINGS.retryWait,
  lowestSpeedLimit: DEFAULT_ENGINE_SETTINGS.lowestSpeedLimit,
  fileAllocation: DEFAULT_ENGINE_SETTINGS.fileAllocation,
  remoteTime: DEFAULT_ENGINE_SETTINGS.remoteTime,
  diskCache: DEFAULT_ENGINE_SETTINGS.diskCache,
  sessionSaveInterval: DEFAULT_ENGINE_SETTINGS.sessionSaveInterval,
  magnetResolveTimeout: DEFAULT_ENGINE_SETTINGS.magnetResolveTimeout,
}

export const DOWNLOADS_DEFAULTS: DownloadsFields = {
  engine: ENGINE_DEFAULTS,
  // Source of truth: src/shared/schemas/speed-limit.ts (DEFAULT_SPEED_LIMIT_SETTINGS).
  speedLimit: DEFAULT_SPEED_LIMIT_SETTINGS,
}
