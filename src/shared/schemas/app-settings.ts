import { RunMode } from '@shared/constants'
import { DEFAULT_LOCALE } from '@shared/constants/locales'
import type { MotrixAppSettings } from '@shared/types/settings'
import { z } from 'zod'
import { supportedLocaleSchema } from './locale'

export const appUpdateChannelSchema = z.enum(['stable', 'beta'])

export const MAGNET_FILE_SELECTION_TIMEOUT_MIN_SECONDS = 10
export const MAGNET_FILE_SELECTION_TIMEOUT_MAX_SECONDS = 3600
export const magnetFileSelectionTimeoutSecondsSchema = z
  .number()
  .int()
  .min(MAGNET_FILE_SELECTION_TIMEOUT_MIN_SECONDS)
  .max(MAGNET_FILE_SELECTION_TIMEOUT_MAX_SECONDS)

export const appSettingsSchema = z.object({
  launchAtStartup: z.boolean().catch(false),
  theme: z.enum(['system', 'light', 'dark']).catch('system'),
  reduceMotion: z.boolean().catch(false),
  language: supportedLocaleSchema.catch(DEFAULT_LOCALE),
  // Empty string is a sentinel: SettingsManager (main/server) seeds the
  // absolute platform download directory on first load. The renderer never
  // observes '' because settings are loaded before the UI mounts.
  defaultSaveDir: z.string().catch(''),
  notifyOnComplete: z.boolean().catch(true),
  notifyOnError: z.boolean().catch(true),
  autofillClipboardLinks: z.boolean().catch(true),
  protocols: z
    .object({
      magnet: z.boolean().catch(true),
    })
    .catch({ magnet: true }),
  runMode: z.enum(RunMode).catch(RunMode.Standard),
  lightweightMode: z.boolean().catch(false),
  traySpeedometer: z.boolean().catch(true),
  magnetFileSelection: z.boolean().catch(true),
  magnetFileSelectionAutoDownload: z.boolean().catch(false),
  magnetFileSelectionTimeoutSeconds:
    magnetFileSelectionTimeoutSecondsSchema.catch(60),
  browserBridgeEnabled: z.boolean().catch(true),
  liquidGlassEffect: z.boolean().catch(false),
  warnBeforeQuit: z.boolean().catch(true),
  checkForUpdatesOnLaunch: z.boolean().catch(true),
  updateChannel: appUpdateChannelSchema.catch('stable'),
})

export const DEFAULT_APP_SETTINGS: MotrixAppSettings = appSettingsSchema.parse(
  {}
)
