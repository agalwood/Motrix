import { z } from 'zod'
import { appSettingsInputSchema } from './app-settings'
import {
  DIRECTORY_PREFERENCES_PATH_LIMIT,
  DirectoryPreferencesSchema,
} from './directory-preferences'
import { engineSettingsInputSchema } from './engine-settings'
import {
  GeneralSettingsErrorCodeSchema,
  SaveGeneralSettingsRequestSchema,
} from './general-settings'
import { settingsUpdateResultSchema } from './settings-update'
import { speedLimitSettingsInputSchema } from './speed-limit'

/** The same form and commit-boundary constraints for both hosts. */
export const downloadsSettingsSchema = z.object({
  app: appSettingsInputSchema.pick({
    defaultSaveDir: true,
    autofillClipboardLinks: true,
    fileDeletionMode: true,
  }),
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
  }),
  speedLimit: speedLimitSettingsInputSchema,
})
const speed = speedLimitSettingsInputSchema
const auto = speed.shape.auto
const speedPatch = speed
  .partial()
  .extend({
    base: speed.shape.base.partial().strict().optional(),
    alt: speed.shape.alt.partial().strict().optional(),
    auto: auto
      .partial()
      .extend({
        schedule: auto.shape.schedule.partial().strict().optional(),
        videoApp: auto.shape.videoApp.partial().strict().optional(),
        adaptive: auto.shape.adaptive
          .partial()
          .extend({
            speedTest: auto.shape.adaptive.shape.speedTest
              .partial()
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
function containsUndefined(value: unknown): boolean {
  return (
    value === undefined ||
    (value !== null &&
      typeof value === 'object' &&
      Object.values(value).some(containsUndefined))
  )
}
export const downloadsSettingsPatchSchema = z
  .object({
    app: downloadsSettingsSchema.shape.app
      .partial()
      .extend({
        defaultSaveDir: z
          .string()
          .min(1)
          .max(DIRECTORY_PREFERENCES_PATH_LIMIT)
          .optional(),
      })
      .strict()
      .optional(),
    engine: downloadsSettingsSchema.shape.engine.partial().strict().optional(),
    speedLimit: speedPatch.optional(),
  })
  .strict()
  .refine((value) => !containsUndefined(value))
export const downloadsSettingsSnapshotSchema = z
  .object({
    revision: z.string().uuid(),
    settings: downloadsSettingsSchema,
    directoryPreferences: DirectoryPreferencesSchema,
  })
  .strict()
export const saveDownloadsSettingsRequestSchema = z
  .object({
    expectedRevision: z.string().uuid(),
    settings: downloadsSettingsPatchSchema,
    directories: SaveGeneralSettingsRequestSchema.shape.directories,
  })
  .strict()
export const downloadsSettingsResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      value: downloadsSettingsSnapshotSchema,
      update: settingsUpdateResultSchema.optional(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: GeneralSettingsErrorCodeSchema }).strict(),
      snapshot: downloadsSettingsSnapshotSchema.optional(),
    })
    .strict(),
])
export type DownloadsSettings = z.infer<typeof downloadsSettingsSchema>
export type DownloadsSettingsSnapshot = z.infer<
  typeof downloadsSettingsSnapshotSchema
>
export type DownloadsSettingsResult = z.infer<
  typeof downloadsSettingsResultSchema
>
export type SaveDownloadsSettingsRequest = z.infer<
  typeof saveDownloadsSettingsRequestSchema
>
