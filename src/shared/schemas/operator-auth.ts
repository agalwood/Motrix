import { z } from 'zod'

export const WEB_ORIGIN_HEADER = 'x-motrix-web-origin'
export const FNOS_EVENT_PROTOCOL = 'motrix.fnos.events'
export const FNOS_EVENT_TICKET_PREFIX = 'motrix.fnos.ticket.'
export const fnosEventTicketSchema = z.object({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
})

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
