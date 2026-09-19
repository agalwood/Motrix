import { z } from 'zod'

export const EngineConnectionSchema = z.object({
  transport: z.literal('websocket'),
  connected: z.boolean(),
})

export type EngineConnectionSnapshot = z.infer<typeof EngineConnectionSchema>
