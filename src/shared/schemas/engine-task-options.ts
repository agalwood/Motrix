import { z } from 'zod'

/** Product-facing request details. Protocol options never cross this boundary. */
export const engineTaskOptionsSchema = z.object({
  connections: z.number().int().positive().optional(),
  headers: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .default([]),
  userAgent: z.string().optional(),
  referrer: z.string().optional(),
  proxyUrl: z.string().optional(),
})
