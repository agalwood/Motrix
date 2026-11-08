import { z } from 'zod'

export const settingsFileLocationSchema = z.object({
  path: z.string().min(1),
})
