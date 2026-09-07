import { z } from 'zod'

export const SERVER_DIRECTORY_PATH_LIMIT = 4096
export const SERVER_DIRECTORY_NAME_LIMIT = 255
export const SERVER_DIRECTORY_SCAN_LIMIT = 10000
export const SERVER_DIRECTORY_ENTRY_LIMIT = 2000

export const DirectoryErrorCodeSchema = z.enum([
  'invalidPath',
  'outsideRoots',
  'notFound',
  'notDirectory',
  'permissionDenied',
  'alreadyExists',
  'invalidName',
  'tooLarge',
  'unavailable',
  'creationOutcomeUnknown',
])
export type DirectoryErrorCode = z.infer<typeof DirectoryErrorCodeSchema>

const DirectoryPathSchema = z.string().min(1).max(SERVER_DIRECTORY_PATH_LIMIT)
const DirectoryEntrySchema = z
  .object({
    name: z.string().min(1).max(SERVER_DIRECTORY_PATH_LIMIT),
    path: DirectoryPathSchema,
  })
  .strict()
const DirectoryFailureSchema = z
  .object({
    ok: z.literal(false),
    error: z.object({ code: DirectoryErrorCodeSchema }).strict(),
  })
  .strict()

export const ListServerDirectoriesRequestSchema = z
  .object({ path: DirectoryPathSchema, showHidden: z.boolean().optional() })
  .strict()
export const ListServerDirectoriesResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      value: z
        .object({
          path: DirectoryPathSchema,
          parentPath: DirectoryPathSchema.nullable(),
          breadcrumbs: z
            .array(DirectoryEntrySchema)
            .min(1)
            .max(SERVER_DIRECTORY_PATH_LIMIT),
          entries: z
            .array(DirectoryEntrySchema)
            .max(SERVER_DIRECTORY_ENTRY_LIMIT),
          truncated: z.boolean(),
          canCreate: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  DirectoryFailureSchema,
])
export const ValidateServerDirectoryRequestSchema = z
  .object({ path: DirectoryPathSchema })
  .strict()
export const ValidateServerDirectoryResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      value: z.object({ path: DirectoryPathSchema }).strict(),
    })
    .strict(),
  DirectoryFailureSchema,
])
export const CreateServerDirectoryRequestSchema = z
  .object({
    parentPath: DirectoryPathSchema,
    name: z.string().min(1).max(SERVER_DIRECTORY_NAME_LIMIT),
  })
  .strict()
export const CreateServerDirectoryResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: DirectoryEntrySchema }).strict(),
  DirectoryFailureSchema,
])
export const AllowedSaveDirsSchema = z
  .object({
    paths: z.array(z.object({ path: DirectoryPathSchema }).strict()),
    defaultPath: z.string().max(SERVER_DIRECTORY_PATH_LIMIT),
    allowCustom: z.boolean(),
  })
  .strict()

export type ListServerDirectoriesRequest = z.infer<
  typeof ListServerDirectoriesRequestSchema
>
export type ListServerDirectoriesResult = z.infer<
  typeof ListServerDirectoriesResultSchema
>
export type ValidateServerDirectoryRequest = z.infer<
  typeof ValidateServerDirectoryRequestSchema
>
export type ValidateServerDirectoryResult = z.infer<
  typeof ValidateServerDirectoryResultSchema
>
export type CreateServerDirectoryRequest = z.infer<
  typeof CreateServerDirectoryRequestSchema
>
export type CreateServerDirectoryResult = z.infer<
  typeof CreateServerDirectoryResultSchema
>
export type AllowedSaveDirs = z.infer<typeof AllowedSaveDirsSchema>
