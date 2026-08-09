import { z } from 'zod'

export const windowBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().min(200),
  height: z.number().min(200),
})

export const windowStateSchema = z
  .record(z.string(), windowBoundsSchema)
  .catch({})
