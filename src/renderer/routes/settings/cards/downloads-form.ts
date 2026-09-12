import { settingsValidationError } from '@renderer/lib/settings-validation'
import { DEFAULT_ENGINE_SETTINGS } from '@shared/schemas'
import { engineSettingsInputSchema } from '@shared/schemas/engine-settings'
import {
  DEFAULT_SPEED_LIMIT_SETTINGS,
  speedLimitSettingsInputSchema,
} from '@shared/schemas/speed-limit'
import type { TFunction } from 'i18next'
import { z } from 'zod'

// ─── Form shape ────────────────────────────────────────────────────────────────
// The form combines the engine settings subset with the full speedLimit
// namespace. On submit, pickDirty recurses the dirty-fields tree and returns
// only changed keys at every level, so { engine: {...}, speedLimit: {...} } is
// built correctly. UpdateSettings deep-merges each top-level namespace, so a
// partial speedLimit patch (only the changed sub-fields) is safe.

export const downloadsFormSchema = z.object({
  engine: engineSettingsInputSchema.pick({
    performanceProfile: true,
    maxConcurrentDownloads: true,
    maxConnectionPerServer: true,
    split: true,
    minSplitSize: true,
    userAgent: true,
    connectTimeout: true,
    socketTimeout: true,
    maxTries: true,
    retryWait: true,
    lowestSpeedLimit: true,
    fileAllocation: true,
    remoteTime: true,
    diskCache: true,
    sessionSaveInterval: true,
    magnetResolveTimeout: true,
  }),
  speedLimit: speedLimitSettingsInputSchema,
})

export type DownloadsFields = z.infer<typeof downloadsFormSchema>
export type EngineFields = DownloadsFields['engine']
export type EngineNumberField = {
  [Key in keyof EngineFields]: EngineFields[Key] extends number ? Key : never
}[keyof EngineFields]

export const KB = 1024
export const MB = 1024 * 1024
// 1 Mbps (megabit per second) = 1_000_000 bits/sec = 125_000 bytes/sec
// Telecom convention: 1 Mbps = 125_000 bytes/sec (not 1024*1024/8).
export const MBPS = 125_000

// Source of truth: src/shared/schemas/engine-settings.ts (DEFAULT_ENGINE_SETTINGS).
// Defaults are sourced from the schema; the renderer mirrors the subset of
// fields it edits, validated with the same constraints and no fallback values.
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

export function getEngineNumberRules(name: EngineNumberField) {
  const schema = downloadsFormSchema.shape.engine.shape[name]
  const scale =
    name === 'minSplitSize' || name === 'diskCache'
      ? MB
      : name === 'lowestSpeedLimit'
        ? KB
        : 1
  return {
    min: (schema.minValue ?? 0) / scale,
    max: (schema.maxValue ?? Number.MAX_SAFE_INTEGER) / scale,
    hasUpperBound: schema.maxValue !== Number.MAX_SAFE_INTEGER,
    scale,
  }
}

export function downloadsValidationError(
  t: TFunction,
  kiloByte: number
): z.core.$ZodErrorMap {
  const scales: Record<string, number> = {}
  for (const [name, schema] of Object.entries(
    downloadsFormSchema.shape.engine.shape
  )) {
    if (schema instanceof z.ZodNumber)
      scales[`engine.${name}`] = getEngineNumberRules(
        name as EngineNumberField
      ).scale
  }
  for (const profile of ['base', 'alt']) {
    for (const direction of ['download', 'upload'])
      scales[`speedLimit.${profile}.${direction}`] = kiloByte
  }
  scales['speedLimit.auto.adaptive.linkDown'] = MBPS
  scales['speedLimit.auto.adaptive.linkUp'] = MBPS
  return settingsValidationError(t, downloadsFormSchema, {
    scales,
    displayRanges: {
      'speedLimit.auto.adaptive.headroomPercent': {
        min: 0,
        max: 99,
        integer: true,
      },
    },
  })
}
