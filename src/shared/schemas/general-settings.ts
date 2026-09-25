import { z } from 'zod'
import { notificationBadgeStyleSchema } from './app-settings'
import {
  DIRECTORY_FAVORITES_LIMIT,
  DIRECTORY_PREFERENCES_PATH_LIMIT,
  DIRECTORY_RECENT_LIMIT,
  DirectoryPreferencesErrorCodeSchema,
  DirectoryPreferencesSchema,
} from './directory-preferences'

const directoryPath = z.string().min(1).max(DIRECTORY_PREFERENCES_PATH_LIMIT)

export const GeneralSettingsAppSchema = z.object({
  launchAtStartup: z.boolean(),
  showMainWindowAtLogin: z.boolean(),
  defaultSaveDir: z.string(),
  notifyOnComplete: z.boolean(),
  notifyOnError: z.boolean(),
  notifyInAppOnComplete: z.boolean(),
  notifyInAppOnError: z.boolean(),
  notificationBadgeStyle: notificationBadgeStyleSchema,
  autofillClipboardLinks: z.boolean(),
  warnBeforeQuit: z.boolean(),
})
export const GeneralSettingsSnapshotSchema = z
  .object({
    revision: z.string().uuid(),
    app: GeneralSettingsAppSchema,
    directoryPreferences: DirectoryPreferencesSchema,
  })
  .strict()
export const GeneralSettingsErrorCodeSchema = z.enum([
  ...DirectoryPreferencesErrorCodeSchema.options,
  'conflict',
])
export const GeneralSettingsResultSchema = z.discriminatedUnion('ok', [
  z
    .object({ ok: z.literal(true), value: GeneralSettingsSnapshotSchema })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: GeneralSettingsErrorCodeSchema }).strict(),
      // Conflicts expose current authority; effect failures expose the committed
      // snapshot so a caller never mistakes a saved value for its old baseline.
      snapshot: GeneralSettingsSnapshotSchema.optional(),
    })
    .strict(),
])
export const GetGeneralSettingsDraftRequestSchema = z.object({}).strict()
export const SaveGeneralSettingsRequestSchema = z
  .object({
    expectedRevision: z.string().uuid(),
    app: GeneralSettingsAppSchema.partial()
      .extend({ defaultSaveDir: directoryPath.optional() })
      .strict()
      .refine((patch) =>
        Object.values(patch).every((value) => value !== undefined)
      ),
    directories: z
      .object({
        addFavorites: z.array(directoryPath).max(DIRECTORY_FAVORITES_LIMIT),
        removeFavorites: z.array(directoryPath).max(DIRECTORY_FAVORITES_LIMIT),
        removeRecent: z.array(directoryPath).max(DIRECTORY_RECENT_LIMIT),
      })
      .strict(),
  })
  .strict()

export type GeneralSettingsApp = z.infer<typeof GeneralSettingsAppSchema>
export type GeneralSettingsSnapshot = z.infer<
  typeof GeneralSettingsSnapshotSchema
>
export type GeneralSettingsResult = z.infer<typeof GeneralSettingsResultSchema>
export type GeneralSettingsErrorCode = z.infer<
  typeof GeneralSettingsErrorCodeSchema
>
export type SaveGeneralSettingsRequest = z.infer<
  typeof SaveGeneralSettingsRequestSchema
>
