import { z } from 'zod'

export const completionShutdownRequestSchema = z
  .object({ enabled: z.boolean() })
  .strict()

export const completionShutdownStateSchema = z.object({
  supported: z.boolean(),
  phase: z.enum([
    'off',
    'waiting',
    'countdown',
    'preparing',
    'requested',
    'failed',
  ]),
  deadline: z.number().nullable(),
  error: z.enum(['unavailable', 'failed']).nullable(),
})

export type CompletionShutdownState = z.infer<
  typeof completionShutdownStateSchema
>
