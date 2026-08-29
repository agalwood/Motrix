import type { EngineSettings } from '@shared/types/settings'
import { z } from 'zod'
import {
  applyEnginePerformanceProfile,
  ENGINE_PERFORMANCE_PROFILE_IDS,
  ENGINE_PERFORMANCE_PROFILES,
  MAX_CONNECTIONS_PER_SERVER,
} from '../constants/engine-performance-profiles'

export { MAX_CONNECTIONS_PER_SERVER } from '../constants/engine-performance-profiles'

const AUTO_PERFORMANCE = ENGINE_PERFORMANCE_PROFILES.auto

const controlFreeString = () =>
  z.string().refine((value) => {
    for (const character of value) {
      const codePoint = character.codePointAt(0) ?? 0
      if (codePoint <= 0x1f || codePoint === 0x7f) return false
    }
    return true
  })

export const engineSettingsSchema = z
  .object({
    // RPC & engine startup (RESTART)
    rpcPort: z.number().int().min(1024).max(65535).catch(16800),
    // Missing/invalid persisted values are a first-run sentinel seeded by
    // SettingsManager while loading; live updates reject non-strings. An
    // explicitly persisted empty string disables tokens.
    rpcSecret: controlFreeString().catch(''),
    listenPort: z.number().int().min(1024).max(65535).catch(6881),
    dhtListenPort: z.number().int().min(1024).max(65535).catch(6881),
    dhtEnabled: z.boolean().catch(true),

    // Performance (HOT, except diskCache)
    performanceProfile: z.enum(ENGINE_PERFORMANCE_PROFILE_IDS).catch('auto'),
    maxConcurrentDownloads: z.number().int().min(1).max(100).catch(5),
    maxConnectionPerServer: z
      .number()
      .int()
      .min(1)
      .max(MAX_CONNECTIONS_PER_SERVER)
      .catch(AUTO_PERFORMANCE.maxConnectionPerServer),
    split: z.number().int().min(1).max(128).catch(AUTO_PERFORMANCE.split),
    minSplitSize: z.number().min(1048576).catch(AUTO_PERFORMANCE.minSplitSize),

    // Network reliability (HOT)
    userAgent: controlFreeString().catch('Motrix/2.0'),
    connectTimeout: z.number().int().min(1).max(600).catch(30),
    socketTimeout: z.number().int().min(1).max(600).catch(30),
    maxTries: z.number().int().min(0).max(100).catch(5),
    retryWait: z.number().int().min(0).max(300).catch(10),
    lowestSpeedLimit: z.number().int().min(0).catch(0),
    dnsMode: z.enum(['auto', 'system', 'engine']).catch('auto'),

    // BitTorrent (HOT)
    btMaxPeers: z.number().int().min(1).max(1000).catch(128),
    btEnableLpd: z.boolean().catch(true),
    seedRatio: z.number().min(0).max(100).catch(1),
    seedTime: z.number().int().min(0).max(525600).catch(60),

    // Disk & session
    fileAllocation: z
      .enum(['none', 'prealloc', 'trunc', 'falloc'])
      .catch('none'),
    remoteTime: z.boolean().catch(false),
    diskCache: z
      .number()
      .int()
      .min(0)
      .max(134217728)
      .catch(AUTO_PERFORMANCE.diskCache),
    sessionSaveInterval: z.number().int().min(10).max(3600).catch(15),

    // SQLite3 persistence
    sqlite3Persistence: z.boolean().catch(true),
    sqlite3DbPath: z
      .string()
      .max(1024)
      .refine((p) => !p.includes('\0'), {
        message: 'settings.engine.sqlite3DbPath.nullByte',
      })
      .catch(''),
    sqlite3HistoryLimit: z
      .number()
      .int()
      .min(-1, { message: 'settings.engine.sqlite3HistoryLimit.minBound' })
      .max(1_000_000, {
        message: 'settings.engine.sqlite3HistoryLimit.maxBound',
      })
      .catch(-1),

    // Magnet (motrix-turbo timer)
    magnetResolveTimeout: z.number().int().min(30).max(600).catch(120),
  })
  .transform(applyEnginePerformanceProfile)

export const DEFAULT_ENGINE_SETTINGS: EngineSettings =
  engineSettingsSchema.parse({})
