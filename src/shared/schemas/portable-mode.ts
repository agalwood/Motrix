import { z } from 'zod'

export const portableModeSchema = z.object({
  enabled: z.boolean(),
  dataDirectory: z.string().optional(),
})
