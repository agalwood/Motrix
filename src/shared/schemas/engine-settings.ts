import type { EngineSettings } from '@shared/types/settings'
import { z } from 'zod'

export const engineSettingsSchema = z.object({
  // RPC & engine startup (RESTART)
  rpcPort: z.number().int().min(1024).max(65535).catch(16800),
  rpcSecret: z.string().catch(''), // sentinel — SettingsManager seeds on first load
  listenPort: z.number().int().min(1024).max(65535).catch(6881),
  dhtListenPort: z.number().int().min(1024).max(65535).catch(6881),
  dhtEnabled: z.boolean().catch(true),

  // Performance (HOT)
  maxConcurrentDownloads: z.number().int().min(1).max(100).catch(5),
  maxConnectionPerServer: z.number().int().min(1).max(16).catch(16),
  split: z.number().int().min(1).max(128).catch(16),
  minSplitSize: z.number().min(1048576).catch(10485760),

  // Network reliability (HOT)
  userAgent: z.string().catch('Motrix/2.0'),
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
  fileAllocation: z.enum(['none', 'prealloc', 'trunc', 'falloc']).catch('none'),
  diskCache: z.number().int().min(0).max(134217728).catch(67108864),
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

export const DEFAULT_ENGINE_SETTINGS: EngineSettings =
  engineSettingsSchema.parse({})
