import { z } from 'zod'

export const checkPluginUpdatesPayloadSchema = z
  .object({ force: z.boolean().optional() })
  .optional()
