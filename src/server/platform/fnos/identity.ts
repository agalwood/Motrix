import type { FastifyRequest } from 'fastify'
import { z } from 'zod'

const gatewayHeadersSchema = z.object({
  'x-trim-userid': z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .transform(Number)
    .pipe(z.number().int().nonnegative().safe()),
  'x-trim-isadmin': z.literal('true'),
  'x-trim-username': z.string().min(1).max(256),
})

export interface FnosGatewayOptions {
  socketPath: string
  now?: () => number
}

export function isFnosListener(
  req: FastifyRequest,
  opts: FnosGatewayOptions
): boolean {
  return (
    req.server.server.address() === opts.socketPath &&
    req.raw.socket.remoteAddress === undefined
  )
}

/** Diagnostic categories deliberately exclude user IDs, names and credentials. */
export function fnosIdentityDiagnostic(
  req: FastifyRequest,
  opts: FnosGatewayOptions
) {
  const headers = req.headers
  const admin = headers['x-trim-isadmin']
  return {
    listenerMatches: req.server.server.address() === opts.socketPath,
    networkPeer: req.raw.socket.remoteAddress !== undefined,
    userIdPresent: typeof headers['x-trim-userid'] === 'string',
    userIdValid: gatewayHeadersSchema.shape['x-trim-userid'].safeParse(
      headers['x-trim-userid']
    ).success,
    administrator:
      admin === undefined
        ? 'missing'
        : typeof admin === 'string' &&
            ['true', 'false', 'True', 'False', '1', '0'].includes(admin)
          ? admin
          : 'invalid',
    usernamePresent: typeof headers['x-trim-username'] === 'string',
  }
}

export function fnosPrincipal(req: FastifyRequest, opts: FnosGatewayOptions) {
  // Header names alone prove nothing. This listener must own the configured
  // Unix socket, and the accepted connection must not be a TCP connection.
  if (!isFnosListener(req, opts)) return undefined
  const parsed = gatewayHeadersSchema.safeParse(req.headers)
  if (!parsed.success) return undefined
  return {
    uid: parsed.data['x-trim-userid'],
    username: parsed.data['x-trim-username'],
  }
}
