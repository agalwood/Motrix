import { z } from 'zod'

export const windowBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().min(200),
  height: z.number().min(200),
})

export const savedWindowStateSchema = windowBoundsSchema.extend({
  maximized: z.boolean().catch(false),
})

export const windowStateSchema = z
  .record(z.string(), savedWindowStateSchema)
  .catch({})
