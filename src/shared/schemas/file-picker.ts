import { z } from 'zod'

export const fileExtensionsSchema = z
  .array(
    z
      .string()
      .regex(/^[a-zA-Z0-9]+$/)
      .max(32)
  )
  .max(32)
  .optional()
export const filePickerOptionsSchema = z
  .object({
    kind: z.enum(['open', 'save']),
    defaultPath: z.string().max(4096).optional(),
    extensions: fileExtensionsSchema,
  })
  .strict()
export type FilePickerOptions = z.infer<typeof filePickerOptionsSchema>
