import { z } from 'zod'

export const WEB_ORIGIN_HEADER = 'x-motrix-web-origin'
export const FNOS_EVENT_PROTOCOL = 'motrix.fnos.events'
export const FNOS_EVENT_TICKET_PREFIX = 'motrix.fnos.ticket.'
export const fnosEventTicketSchema = z.object({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
})

export const clientPairingCapabilitiesSchema = z
  .object({
    cli: z.boolean(),
    extension: z.boolean(),
  })
  .readonly()
export type ClientPairingCapabilities = z.infer<
  typeof clientPairingCapabilitiesSchema
>

export const operatorStatusSchema = z.object({
  authed: z.boolean(),
  mode: z.enum([
    'cookie',
    'bearer',
    'unrestricted',
    'unauthenticated',
    'fnosGateway',
    'synologyDsm',
  ]),
  username: z.string().optional(),
  canLogout: z.boolean(),
  eventOriginMatches: z.boolean().optional(),
  clientPairing: clientPairingCapabilitiesSchema.optional(),
})

export function isNasAuthMode(mode: string | undefined): boolean {
  return mode === 'fnosGateway' || mode === 'synologyDsm'
}

export type OperatorStatus = z.infer<typeof operatorStatusSchema>

/** Older ordinary Server and Electron hosts predate capability reporting. */
export function supportsClientPairing(
  status: OperatorStatus | null,
  kind: keyof ClientPairingCapabilities
): boolean {
  if (status && !status.authed) return false
  return status?.clientPairing?.[kind] ?? !isNasAuthMode(status?.mode)
}
