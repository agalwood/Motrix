import { z } from 'zod'

export const setSelectedFilesPayloadSchema = z
  .object({
    taskId: z.string().min(1),
    indices: z.array(z.number().int().nonnegative()).min(1),
  })
  .refine((value) => new Set(value.indices).size === value.indices.length, {
    message: 'File selection contains duplicate indices',
    path: ['indices'],
  })

export type SetSelectedFilesPayload = z.infer<
  typeof setSelectedFilesPayloadSchema
>
