import { z } from 'zod'
import { nasRootPathSchema } from './nas-settings'

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

export const nasCapabilitiesSchema = z
  .object({
    settings: z.boolean(),
    fileActions: z.boolean(),
    torrentPicker: z.boolean(),
    clientGateway: z.boolean(),
  })
  .readonly()
export type NasCapabilities = z.infer<typeof nasCapabilitiesSchema>

/** Safe support metadata only: no session, account name, command output or path. */
export const nasAuthDiagnosticSchema = z
  .object({
    stage: z.enum(['gateway', 'session', 'account']),
    code: z.enum([
      'untrustedListener',
      'missingCookie',
      'invalidContext',
      'rejected',
      'commandFailed',
      'unavailable',
    ]),
    failure: z
      .enum([
        'accessDenied',
        'notFound',
        'timeout',
        'outputLimit',
        'exit',
        'unavailable',
      ])
      .optional(),
    exitCode: z.number().int().min(0).max(255).optional(),
  })
  .strict()
  .readonly()
export type NasAuthDiagnostic = z.infer<typeof nasAuthDiagnosticSchema>

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
  nasAuthDiagnostic: nasAuthDiagnosticSchema.optional(),
  nasCapabilities: nasCapabilitiesSchema.optional(),
  nasUnavailableDownloadRoots: z
    .array(nasRootPathSchema)
    .min(1)
    .max(64)
    .optional(),
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
