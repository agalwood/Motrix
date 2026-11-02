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
}

export function fnosPrincipal(req: FastifyRequest, opts: FnosGatewayOptions) {
  // Header names alone prove nothing. This listener must own the configured
  // Unix socket, and the accepted connection must not be a TCP connection.
  if (
    req.server.server.address() !== opts.socketPath ||
    req.raw.socket.remoteAddress !== undefined
  )
    return undefined
  const parsed = gatewayHeadersSchema.safeParse(req.headers)
  if (!parsed.success) return undefined
  return {
    uid: parsed.data['x-trim-userid'],
    username: parsed.data['x-trim-username'],
  }
}
