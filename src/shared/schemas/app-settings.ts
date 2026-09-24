import { RunMode } from '@shared/constants'
import { DEFAULT_LOCALE } from '@shared/constants/locales'
import type { MotrixAppSettings } from '@shared/types/settings'
import { z } from 'zod'
import {
  byteUnitSystemSchema,
  DEFAULT_BYTE_UNIT_PREFERENCE,
} from './byte-unit-system'
import { DirectoryPreferencesSchema } from './directory-preferences'
import { supportedLocaleSchema } from './locale'
import { settingsInputObject } from './settings-input'
import { DEFAULT_TRAY_ICON_COLOR, trayIconColorSchema } from './tray-icon-color'

export const appUpdateChannelSchema = z.enum(['stable', 'beta'])
export const fileDeletionModeSchema = z.enum(['trash', 'permanent'])
export type FileDeletionMode = z.infer<typeof fileDeletionModeSchema>

export const MAGNET_FILE_SELECTION_TIMEOUT_MIN_SECONDS = 10
export const MAGNET_FILE_SELECTION_TIMEOUT_MAX_SECONDS = 3600
export const magnetFileSelectionTimeoutSecondsSchema = z
  .number()
  .int()
  .min(MAGNET_FILE_SELECTION_TIMEOUT_MIN_SECONDS)
  .max(MAGNET_FILE_SELECTION_TIMEOUT_MAX_SECONDS)

/** Dot-prefixed lowercase extensions used to seed the initial AutoParser
 *  whitelist when the settings file does not exist yet (or lacks the
 *  autoparser section). Kept standalone so the field-level and object-level
 *  schema fallbacks share one predefined default list. */
export const DEFAULT_AUTOPARSER_FILE_EXTENSION_WHITELIST: string[] = [
  // Video
  '.mp4',
  '.avi',
  '.mkv',
  '.mov',
  '.wmv',
  '.flv',
  '.webm',
  '.m4v',
  '.mpg',
  '.mpeg',
  '.ts',
  '.rmvb',
  // Archive / disk image
  '.iso',
  '.img',
  '.tar',
  '.tgz',
  '.zip',
  '.rar',
  '.7z',
  '.gz',
  '.bz2',
  '.xz',
  '.zst',
  '.dmg',
  // LLM model files
  '.safetensors',
  '.json',
  '.md',
  '.txt',
  '.gguf',
  '.ggml',
  '.ckpt',
  '.pt',
  '.pth',
  '.onnx',
  '.bin',
  '.msgpack',
]

export const appSettingsSchema = z.object({
  launchAtStartup: z.boolean().catch(false),
  showMainWindowAtLogin: z.boolean().catch(false),
  theme: z.enum(['system', 'light', 'dark']).catch('system'),
  reduceMotion: z.boolean().catch(false),
  language: supportedLocaleSchema.catch(DEFAULT_LOCALE),
  byteUnitSystem: byteUnitSystemSchema.catch(DEFAULT_BYTE_UNIT_PREFERENCE),
  // Empty string is a sentinel: SettingsManager (main/server) seeds the
  // absolute platform download directory on first load. The renderer never
  // observes '' because settings are loaded before the UI mounts.
  defaultSaveDir: z.string().catch(''),
  fileDeletionMode: fileDeletionModeSchema.catch('trash'),
  directoryPreferences: DirectoryPreferencesSchema.catch({
    favorites: [],
    recent: [],
  }),
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
  trayIconColor: trayIconColorSchema.catch(DEFAULT_TRAY_ICON_COLOR),
  magnetFileSelection: z.boolean().catch(true),
  magnetFileSelectionAutoDownload: z.boolean().catch(false),
  magnetFileSelectionTimeoutSeconds:
    magnetFileSelectionTimeoutSecondsSchema.catch(60),
  browserBridgeEnabled: z.boolean().catch(true),
  liquidGlassEffect: z.boolean().catch(false),
  warnBeforeQuit: z.boolean().catch(true),
  checkForUpdatesOnLaunch: z.boolean().catch(true),
  updateChannel: appUpdateChannelSchema.catch('stable'),
  // Skip-new-task destination collisions: when true, an HTTP create whose
  // final file already exists (or whose staging file is owned by an active
  // task) is skipped instead of auto-renamed. Default true enables the skip
  // behavior for new installs; existing users keep their saved value.
  skipExistingFilesOnCreate: z.boolean().catch(true),
  autoparser: z
    .object({
      /** Dot-prefixed lowercase extensions, e.g. ['.mp4', '.iso', '.gguf'].
       *  Only links whose URL path extension matches the whitelist are
       *  surfaced; an empty whitelist yields no results. When the whitelist
       *  is absent (fresh install or a settings file without autoparser),
       *  it is seeded from the predefined default list. */
      fileExtensionWhitelist: z
        .array(z.string().regex(/^\.[a-z0-9]+$/i))
        .catch(DEFAULT_AUTOPARSER_FILE_EXTENSION_WHITELIST),
    })
    .catch({
      fileExtensionWhitelist: DEFAULT_AUTOPARSER_FILE_EXTENSION_WHITELIST,
    }),
})

export const DEFAULT_APP_SETTINGS: MotrixAppSettings = appSettingsSchema.parse(
  {}
)

export const appSettingsInputSchema = settingsInputObject(
  appSettingsSchema
).extend({
  defaultSaveDir: z
    .string()
    .refine((value) => value.trim().length > 0 && !value.includes('\0'), {
      params: { settingIssue: 'directory' },
    }),
  protocols: settingsInputObject(
    appSettingsSchema.shape.protocols.removeCatch()
  ),
})
