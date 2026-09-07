import { z } from 'zod'
import {
  DIRECTORY_FAVORITES_LIMIT,
  DIRECTORY_PREFERENCES_PATH_LIMIT,
  DIRECTORY_RECENT_LIMIT,
} from './directory-preferences'

const directoryPath = z.string().min(1).max(DIRECTORY_PREFERENCES_PATH_LIMIT)

export const SaveGeneralSettingsRequestSchema = z
  .object({
    app: z
      .object({
        launchAtStartup: z.boolean().optional(),
        defaultSaveDir: directoryPath.optional(),
        notifyOnComplete: z.boolean().optional(),
        notifyOnError: z.boolean().optional(),
        autofillClipboardLinks: z.boolean().optional(),
        warnBeforeQuit: z.boolean().optional(),
      })
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

export type SaveGeneralSettingsRequest = z.infer<
  typeof SaveGeneralSettingsRequestSchema
>
