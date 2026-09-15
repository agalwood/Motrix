import { z } from 'zod'

export const DIRECTORY_FAVORITES_LIMIT = 20
export const DIRECTORY_RECENT_LIMIT = 10
export const DIRECTORY_PREFERENCES_PATH_LIMIT = 4096

const savedPath = z.string().min(1).max(DIRECTORY_PREFERENCES_PATH_LIMIT)
export const DirectoryPreferencesSchema = z
  .object({
    favorites: z.array(savedPath).max(DIRECTORY_FAVORITES_LIMIT),
    recent: z.array(savedPath).max(DIRECTORY_RECENT_LIMIT),
  })
  .strict()
export const DirectoryPreferencesErrorCodeSchema = z.enum([
  'invalidPath',
  'outsideRoots',
  'notFound',
  'notDirectory',
  'permissionDenied',
  'tooLarge',
  'unavailable',
  'limitReached',
])
export const DirectoryPreferencesResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: DirectoryPreferencesSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: DirectoryPreferencesErrorCodeSchema }).strict(),
    })
    .strict(),
])
export const GetDirectoryPreferencesRequestSchema = z.object({}).strict()
export const MutateDirectoryPreferencesRequestSchema = z.discriminatedUnion(
  'action',
  [
    z.object({ action: z.literal('addFavorite'), path: savedPath }).strict(),
    z.object({ action: z.literal('recordRecent'), path: savedPath }).strict(),
    z
      .object({
        action: z.literal('removeFavorite'),
        paths: z.array(savedPath).min(1).max(DIRECTORY_FAVORITES_LIMIT),
      })
      .strict(),
    z
      .object({
        action: z.literal('removeRecent'),
        paths: z.array(savedPath).min(1).max(DIRECTORY_RECENT_LIMIT),
      })
      .strict(),
    z.object({ action: z.literal('clearRecent') }).strict(),
  ]
)
export type DirectoryPreferences = z.infer<typeof DirectoryPreferencesSchema>
export type DirectoryPreferencesResult = z.infer<
  typeof DirectoryPreferencesResultSchema
>
export type DirectoryPreferencesErrorCode = z.infer<
  typeof DirectoryPreferencesErrorCodeSchema
>
export type MutateDirectoryPreferencesRequest = z.infer<
  typeof MutateDirectoryPreferencesRequestSchema
>
