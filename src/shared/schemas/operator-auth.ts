import { z } from 'zod'

export const operatorStatusSchema = z.object({
  authed: z.boolean(),
  mode: z.enum([
    'cookie',
    'bearer',
    'unrestricted',
    'unauthenticated',
    'fnosGateway',
  ]),
  username: z.string().optional(),
  canLogout: z.boolean(),
  eventOriginMatches: z.boolean().optional(),
})

export type OperatorStatus = z.infer<typeof operatorStatusSchema>
