import { z } from 'zod'

// Electron window dimensions are signed 32-bit integers. Zero removes the
// application minimum; saved windows still need a positive area.
export const windowMinimumDimensionSchema = z
  .number()
  .int()
  .min(0)
  .max(2_147_483_647)

export const windowBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: windowMinimumDimensionSchema.positive(),
  height: windowMinimumDimensionSchema.positive(),
})

export const savedWindowStateSchema = windowBoundsSchema.extend({
  maximized: z.boolean().catch(false),
})

export const windowStateSchema = z
  .record(z.string(), savedWindowStateSchema)
  .catch({})
