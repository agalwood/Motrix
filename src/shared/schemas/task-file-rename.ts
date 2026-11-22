import { z } from 'zod'

export const taskFileNameSchema = z
  .string()
  .min(1)
  .refine(
    (name) =>
      !/[<>:"/\\|?*]/u.test(name) &&
      Array.from(name).every((character) => character.charCodeAt(0) >= 32) &&
      !/[. ]$/u.test(name) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name) &&
      new TextEncoder().encode(name).length <= 254,
    'task.fileRename.invalid'
  )

export const taskFileRenameSchema = z.object({
  taskId: z.string().min(1),
  engineTaskId: z.string().min(1),
  fileIndex: z.number().int().nonnegative(),
  expectedName: z.string().min(1),
  name: taskFileNameSchema,
})

/** Observed engine paths, relative to the payload root (single file: its parent). */
export const btFilePathsSchema = z.record(
  z.string().regex(/^\d+$/),
  z.string().min(1)
)
export type BtFilePaths = z.infer<typeof btFilePathsSchema>
