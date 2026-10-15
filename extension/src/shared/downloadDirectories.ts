import {
  type DownloadDirectoriesResult,
  DownloadDirectoryPathSchema,
} from '@motrix/mdxp'
import { z } from 'zod'

const directoryPath = z
  .string()
  .refine((value) => DownloadDirectoryPathSchema.safeParse(value).success)

export const directorySelectionSchema = z
  .object({
    path: directoryPath,
    endpointId: z.string().min(1).max(256),
    endpointRevision: z.number().int().nonnegative(),
    instanceId: z.string().min(1).max(256),
  })
  .strict()
export type DirectorySelection = z.infer<typeof directorySelectionSchema>
export type DownloadDirectoriesResponse =
  | {
      status: 'ready'
      directories: DownloadDirectoriesResult
      binding: Omit<DirectorySelection, 'path'>
    }
  | { status: 'unsupported' | 'unavailable' }
